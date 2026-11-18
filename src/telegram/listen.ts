// The listener of 5.2: the one process that calls getUpdates. It holds the store's `listener`
// lock for its whole run, so only one listener per store writes `cursor`, `listener` and the
// stored messages and delivers answers and messages. Per update it runs `chat.handle`, stores a
// message for `onMessage`, and only then moves the cursor, so a crash in between fetches the
// update again, and the question's replay check makes the second `handle` a no-op. Answers
// reach the consumer through `chat.flush` and messages through the courier of messages.ts, both
// at the start with `restart`, every 30 s and after each new one. With a view client, it applies
// the choices its view host stored at the start and every 3 s, see `applyChoices`. Every write
// the listener starts ends before it gives up the lock.
import type { Message } from '@grammyjs/types';
import { message } from '../core/builders.ts';
import { arrayOf, isInt, isNat, isRecord, isString } from '../core/check.ts';
import { mergeLabels } from '../core/labels.ts';
import { parseQuestion } from '../core/parse.ts';
import { bindingOf, bodyLike } from '../core/render.ts';
import { type Call, type CallResponse, type Handled, type Labels, LockTimeout, type Question, ShapeError, type Store, type StoredChoice, TokenRefused, type Update, type ViewClient } from '../core/types.ts';
import { NO_ANSWER } from '../chat/calls.ts';
import { type Chat, indexKey, tombstoneKey } from '../chat/create.ts';
import { LISTENER_KEY, parseListener, writeListener } from '../chat/listener.ts';
import type { Transport } from './fetch.ts';
import { courier, type Inbound, inbound, messageKey, type StoredMessage } from './messages.ts';

export type { Inbound };

/**
 * Timing of the listener in ms: `beat` is how often it writes its heartbeat and flushes, `pause`
 * how long it waits after a poll that failed, `choices` how often it reads the choices of its
 * view host. The tests of this package shorten them.
 */
export const LISTEN = { beat: 30_000, pause: 5_000, choices: 3_000 };
/** The `timeout` of every long poll, in seconds. */
export const POLL_TIMEOUT = 50;
/** Telegram drops a tap that no poll fetched within this many ms. */
export const MISSED_AFTER = 150_000;
/** A closed question is deleted this many ms after its creation. */
export const KEEP_CLOSED = 30 * 86_400_000;
const CLEAN_EVERY = 3_600_000;

/**
 * Whether the view host may still take choices for a closed question answered in its view: its
 * closed binding is unpaid, or a recheck is due because an earlier context write got no answer
 * and may still land over the closed one. Either ends at the question's `expiresAt`, from which
 * on the host refuses every choice by the binding's own expiry.
 */
const owesHost = (question: Question, at: number): boolean =>
	question.bindingOwed === true || (bindingOf(question) !== undefined && question.shown.recheckAt !== undefined && question.expiresAt !== undefined && at < question.expiresAt);
// Telegram picks the next update id at random after a week without updates. An offset from
// before such a week could lie above the new ids and confirm them unread, so a cursor older
// than 6 days is not sent.
const CURSOR_AGE = 6 * 86_400_000;
const CURSOR_KEY = 'cursor';
const UPDATES = ['message', 'callback_query'] as const;

/** Why `listen` returned. Every reason but `signal` ends the listener for good: a restart would meet the same cause. */
export type Stopped = { reason: 'signal' } | { reason: 'conflict' | 'webhook' | 'token' | 'lease'; message: string };

export type ListenOptions = {
	/** The chat the updates go to. Its `onAnswer`, if any, receives every answer. */
	chat: Chat;
	call: Transport;
	/** The store of `chat`: the lease, `cursor`, `listener` and the stored messages live in it. */
	store: Store;
	/** Aborting it stops the listener with the reason `signal`. */
	signal: AbortSignal;
	/** The labels of `chat`, for the notice about missed taps. */
	labels?: Partial<Labels>;
	/** The meta keys an answer command needs. With it, the `listener` key tells an asker that answers are pushed. */
	push?: { metaKeys: string[] };
	/** The client of the view host of `chat`. With it, the listener applies the choices made in views. */
	views?: ViewClient;
	/** Default Date.now. */
	now?: () => number;
	/** Progress lines: failed polls, failed flushes, skipped updates. */
	log?: (line: string) => void;
} & ({ onMessage?: never; allow?: never } | { onMessage: (message: Inbound) => Promise<void>; allow: number[] });

type Cursor = { v: 1; offset: number; at: number };

const parseCursor = (value: unknown): Cursor | undefined => (isRecord(value) && value.v === 1 && isNat(value.offset) && isNat(value.at) ? { v: 1, offset: value.offset, at: value.at } : undefined);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
/** An update as JSON delivers it. Only its id is checked here: `handle` checks every field it reads and rejects the rest with ShapeError. */
export const isUpdate = (value: unknown): value is Update => isRecord(value) && isNat(value.update_id);

/** What one pass of `applyChoices` did: answers it applied, choices it removed from the host, and choices it left for the next pass. */
export type ChoicePass = { answered: number; removed: number; left: number };

/** Choices in the order they are applied: by the host's time, then by choice id. */
const byTime = (a: StoredChoice, b: StoredChoice) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * One pass over the choices the view host stored. It lists them through `views.choices()`,
 * which changes nothing, and applies each in the order of `at`, then choice id, with
 * `chat.choose`. A choice is removed from the host only after its result is stored, so a pass
 * that dies between the two applies it again later as a repeat, which changes nothing. A choice
 * whose store failed stays for the next pass, and so do the later choices of its ref, which keeps
 * their order. A failed removal leaves the choice too. Rejects when the host gives no list, and
 * with TokenRefused when an edit meets a rejected token.
 *
 *   const pass = await applyChoices({ chat, views });
 *   if (pass.answered > 0) await chat.flush();
 */
export async function applyChoices(options: { chat: Chat; views: ViewClient; log?: (line: string) => void; stopped?: () => boolean }): Promise<ChoicePass> {
	const { chat, views } = options;
	const log = options.log ?? (() => {});
	const read = await views.choices();
	if (read.kind !== 'ok') throw new Error(`the view host refused to list its choices: ${read.reason}`);
	const pass: ChoicePass = { answered: 0, removed: 0, left: 0 };
	// The refs whose earlier choice stays for the next pass: their later choices wait with it.
	const waiting = new Set<string>();
	for (const choice of [...read.choices].sort(byTime)) {
		if (options.stopped?.() || waiting.has(choice.ref)) {
			pass.left++;
			continue;
		}
		let handled: Handled;
		try {
			handled = await chat.choose(choice);
		} catch (error) {
			if (error instanceof TokenRefused) throw error;
			if (!(error instanceof ShapeError)) {
				waiting.add(choice.ref);
				pass.left++;
				log(`choice ${choice.key} was not applied and stays for the next pass: ${describe(error)}`);
				continue;
			}
			// A choice that breaks its type can never apply: it is removed like a refused one.
			log(`choice ${choice.key} breaks its type: ${error.message}`);
			handled = { kind: 'ignored' };
		}
		if (handled.kind === 'answered') pass.answered++;
		const removed = await views.removeChoice(choice.key).catch((error: unknown) => ({ kind: 'refused' as const, reason: describe(error) }));
		if (removed.kind === 'ok') pass.removed++;
		else {
			pass.left++;
			log(`choice ${choice.key} was applied and stays on the view host for the next pass: ${removed.reason}`);
		}
	}
	return pass;
}

/** Why a getUpdates answer stops the listener, or undefined: a 409 for a second poll or a webhook, a 401 for the token. */
function stopFor(response: CallResponse): Exclude<Stopped, { reason: 'signal' | 'lease' }> | undefined {
	if ('noAnswer' in response || response.ok) return undefined;
	if (response.status === 409) return { reason: /webhook/i.test(response.description) ? 'webhook' : 'conflict', message: response.description };
	if (response.status === 401) return { reason: 'token', message: response.description };
	return undefined;
}

/**
 * Polls getUpdates for `chat` until `signal` aborts or Telegram ends it, and returns why it
 * stopped. It holds the store's lock of `listener` from start to end: a second listener on the
 * same store waits for it and returns `lease` once the lock's wait runs out. Throws ShapeError
 * for `push` or `allow` that break their types, before it takes the lock.
 *
 * At the start it writes its heartbeat, stops when the bot has a webhook, and renews the spent
 * deliveries with `chat.flush({ restart: true })` and the same for messages. Each long poll asks
 * with `timeout: 50` for messages and callback queries. Per update it runs `chat.handle`, stores
 * a message that `handle` ignored for `onMessage` when its sender is in `allow` and it is in a
 * private chat, and then stores the cursor. After more than 150 s without an answered poll, in
 * this run or since the previous one, the next poll asks with `timeout: 0`, and once it answers
 * the listener sends `labels.missed` while a question takes answers. Every 30 s it writes its
 * heartbeat and delivers what is owed, and once an hour it deletes closed questions older than
 * 30 days whose newest answer was delivered and for which the view host takes no choice,
 * leaving a tombstone. With `views`, it runs
 * `applyChoices` at the start and every 3 s, one pass at a time, and flushes after a pass that
 * applied an answer.
 *
 * It stops on a 409, which means a newer poll on the token or a webhook, and on a rejected
 * token, and never polls again after either. Before it returns, every delivery and write it
 * started has ended, and the `listener` key holds the reason.
 *
 *   const chat = createChat({ call, store, chat: 111, onAnswer });
 *   const stopped = await listen({ chat, call, store, signal: AbortSignal.timeout(3_600_000) });
 */
export async function listen(options: ListenOptions): Promise<Stopped> {
	const { store } = options;
	if (options.push !== undefined && !(isRecord(options.push) && arrayOf(isString)(options.push.metaKeys))) throw new ShapeError('push.metaKeys is not a list of strings');
	if (options.allow !== undefined && !arrayOf(isInt)(options.allow)) throw new ShapeError('allow is not a list of user ids');
	// The stored form: a fresh dense array, whatever the caller does with its own later.
	const push = options.push && { metaKeys: [...options.push.metaKeys] };
	let entered = false;
	try {
		return await store.lock(LISTENER_KEY, () => {
			entered = true;
			return run(options, push);
		});
	} catch (error) {
		if (!entered && error instanceof LockTimeout) return { reason: 'lease', message: `another listener holds this store: ${error.message}` };
		throw error;
	}
}

/** The listener's run, inside the lease. */
async function run(options: ListenOptions, push: { metaKeys: string[] } | undefined): Promise<Stopped> {
	const { chat, store, signal } = options;
	// A transport that throws counts as one without an answer, as in `createChat`.
	const call = (request: Call) => Promise.resolve().then(() => options.call(request)).catch(() => NO_ANSWER);
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => {});
	const labels = mergeLabels(options.labels);
	const messages = options.onMessage ? courier(store, options.onMessage, log) : undefined;

	let stopped: Stopped | undefined;
	const stopping = new AbortController();
	const halt = (reason: Stopped) => {
		stopped ??= reason;
		stopping.abort();
	};
	const onSignal = () => halt({ reason: 'signal' });
	signal.addEventListener('abort', onSignal, { once: true });
	if (signal.aborted) onSignal();
	const ended = new Promise<undefined>((resolve) => stopping.signal.addEventListener('abort', () => resolve(undefined), { once: true }));
	/** `promise`, or undefined once the listener stops. */
	const unlessStopped = <T>(promise: Promise<T>) => Promise.race([promise, ended]);
	const pause = (ms: number) => unlessStopped(new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const tokenStop = (error: unknown): Stopped => ({ reason: 'token', message: describe(error) });

	// Every task that may still write to the store: drained before the lock is given up.
	const pending = new Set<Promise<void>>();
	const track = (task: Promise<void>) => {
		pending.add(task);
		void task.finally(() => pending.delete(task));
	};

	const previous = parseListener(await store.get(LISTENER_KEY));
	// The time of the last poll Telegram answered, from the previous run until this one polls.
	let polled = previous?.polled ?? previous?.heartbeat;
	// The record's own fields; `writeListener` keeps the renewed baselines the delivery workers store.
	const record = (extra: { stopped?: string } = {}) => ({ heartbeat: now(), ...(polled !== undefined ? { polled } : {}), ...(push ? { push } : {}), ...extra });
	// Writes of the `listener` key run one after another, so an older one never lands after a newer one.
	let writing: Promise<void> = Promise.resolve();
	const write = (extra: { stopped?: string } = {}) => {
		writing = writing.then(() => writeListener(store, record(extra))).catch((error: unknown) => log(`the listener record was not stored: ${describe(error)}`));
		return writing;
	};
	const beat = () => track(write());

	const flush = (restart = false) => {
		track(
			chat.flush(restart ? { restart: true } : {}).catch((error: unknown) => {
				if (error instanceof TokenRefused) halt(tokenStop(error));
				else log(`flush failed: ${describe(error)}`);
			}),
		);
	};
	const deliverMessages = (restart = false) => {
		if (messages) track(messages.deliver(restart ? { restart: true } : {}).catch((error: unknown) => log(`message delivery failed: ${describe(error)}`)));
	};

	// One pass over the view host's choices at a time; an answer it applied is delivered by a flush.
	const { views } = options;
	let picking = false;
	const pick = () => {
		if (!views || picking || stopped) return;
		picking = true;
		track(
			applyChoices({ chat, views, log, stopped: () => stopped !== undefined })
				.then(
					(pass) => {
						if (pass.answered > 0) flush();
					},
					(error: unknown) => {
						if (error instanceof TokenRefused) halt(tokenStop(error));
						else log(`the choices of the view host were not read: ${describe(error)}`);
					},
				)
				.finally(() => {
					picking = false;
				}),
		);
	};

	/**
	 * Deletes every closed question older than KEEP_CLOSED whose newest answer was delivered and
	 * whose view host holds its closed binding: the tombstone first, then the index entry, then
	 * the question. An answer still owed keeps its question, and so does a host that may still
	 * take choices for it (`owesHost`), until the question's `expiresAt` at the latest.
	 */
	async function clean(): Promise<void> {
		for (const key of await store.list('q:')) {
			try {
				await store.lock(key, async () => {
					const question = parseQuestion(await store.get(key));
					if (!question || question.status !== 'closed' || now() - question.createdAt < KEEP_CLOSED) return;
					if (question.delivery.seq < question.seq || owesHost(question, now())) return;
					await store.set(tombstoneKey(question.ref), { v: 1, at: now() });
					if (question.sent) await store.delete(indexKey(question.sent));
					await store.delete(key);
				});
			} catch (error) {
				log(`cleanup of ${key} failed: ${describe(error)}`);
			}
		}
	}
	let cleaned = now();
	const cleaning = () => track(clean().catch((error: unknown) => log(`cleanup failed: ${describe(error)}`)));

	/** Sends `labels.missed` when a question still takes answers, since only a tap on one can have been dropped. */
	async function notice(): Promise<void> {
		let open = false;
		for (const key of await store.list('q:')) {
			const question = parseQuestion(await store.get(key));
			if (question && question.status !== 'closed') open = true;
		}
		if (!open) return;
		const outcome = await chat.send(message(bodyLike({ markdown: '-' }, labels.missed)));
		if (outcome.kind === 'refused' && outcome.code === 'token') halt({ reason: 'token', message: outcome.reason });
		else if (outcome.kind !== 'ok') log(`the notice about missed taps was not sent: ${outcome.kind}`);
	}

	/** Stores an ignored private message from a user in `allow` for `onMessage`. False when it could not be stored. */
	async function keep(update: Update, found: Message): Promise<boolean> {
		if (!messages || !found.from || !options.allow?.includes(found.from.id) || found.chat.type !== 'private') return true;
		try {
			const replyTo = found.reply_to_message?.message_id;
			// `handle` wrote the index entry of every reply whose question it found.
			const entry = replyTo === undefined ? undefined : await store.get(indexKey({ chat: found.chat.id, message: replyTo }));
			const stored: StoredMessage = { v: 1, chat: found.chat.id, update: update.update_id, message: inbound(found, isString(entry) ? entry : undefined), attempts: 0 };
			// A message fetched again, under its old or a new update id, keeps its entry and its attempts.
			const key = messageKey({ chat: found.chat.id, message: found.message_id });
			if ((await store.get(key)) === undefined) await store.set(key, stored);
		} catch (error) {
			log(`message of update ${update.update_id} was not stored and is fetched again: ${describe(error)}`);
			return false;
		}
		deliverMessages();
		return true;
	}

	/** One update: `handle`, an answer's flush, an ignored message's storage. False when the update is to be fetched again. */
	async function take(update: Update): Promise<boolean> {
		let handled: Handled;
		try {
			handled = await chat.handle(update);
		} catch (error) {
			if (error instanceof TokenRefused) {
				halt(tokenStop(error));
				return false;
			}
			if (error instanceof ShapeError) {
				log(`update ${update.update_id} skipped: ${error.message}`);
				return true;
			}
			// A lock held elsewhere or a store that failed: the update comes again with the next poll.
			log(`update ${update.update_id} failed and is fetched again: ${describe(error)}`);
			return false;
		}
		if (handled.kind === 'answered') flush();
		if (handled.kind === 'ignored' && update.message) return keep(update, update.message);
		return true;
	}

	beat();
	await writing;
	const timer = setInterval(() => {
		beat();
		flush();
		deliverMessages();
		if (now() - cleaned >= CLEAN_EVERY) {
			cleaned = now();
			cleaning();
		}
	}, LISTEN.beat);
	const choiceTimer = views ? setInterval(pick, LISTEN.choices) : undefined;
	try {
		const hook = await unlessStopped(call({ method: 'getWebhookInfo', payload: {} }));
		if (hook) {
			const url = 'ok' in hook && hook.ok && isRecord(hook.result) ? hook.result.url : undefined;
			if (isString(url) && url !== '') halt({ reason: 'webhook', message: 'the bot has a webhook, and getUpdates works only without one' });
			else if (stopFor(hook)?.reason === 'token') halt({ reason: 'token', message: 'the server refused the bot token' });
		}
		if (!stopped) {
			flush(true);
			deliverMessages(true);
			cleaning();
			pick();
		}
		let cursor = parseCursor(await store.get(CURSOR_KEY));
		while (!stopped) {
			const offset = cursor && now() - cursor.at < CURSOR_AGE ? cursor.offset : undefined;
			// After a pause, a poll that answers at once tells that Telegram is reachable again, and the notice goes out then.
			const missed = polled !== undefined && now() - polled > MISSED_AFTER;
			const payload = { ...(offset !== undefined ? { offset } : {}), timeout: missed ? 0 : POLL_TIMEOUT, allowed_updates: [...UPDATES] };
			const response = await unlessStopped(call({ method: 'getUpdates', payload }));
			if (!response) break;
			const stop = stopFor(response);
			if (stop) {
				halt(stop);
				break;
			}
			if ('noAnswer' in response || !response.ok) {
				const wait = !('noAnswer' in response) && response.status === 429 ? Math.max(0, (response.retryAfter ?? now()) - now()) : LISTEN.pause;
				log(`getUpdates failed: ${'noAnswer' in response ? 'no answer' : `${response.status} ${response.description}`}`);
				await pause(wait);
				continue;
			}
			const updates = Array.isArray(response.result) ? response.result : undefined;
			if (!updates?.every(isUpdate)) {
				log('getUpdates answered with no list of updates');
				await pause(LISTEN.pause);
				continue;
			}
			if (missed) await notice().catch((error: unknown) => log(`the notice about missed taps failed: ${describe(error)}`));
			polled = now();
			beat();
			for (const update of updates) {
				if (stopped || !(await take(update))) break;
				cursor = { v: 1, offset: update.update_id + 1, at: now() };
				try {
					await store.set(CURSOR_KEY, cursor);
				} catch (error) {
					// The update was handled; its next fetch is a replay that changes nothing.
					log(`the cursor was not stored: ${describe(error)}`);
					break;
				}
			}
			if (!stopped && updates.some((update) => cursor === undefined || update.update_id >= cursor.offset)) await pause(LISTEN.pause);
		}
	} finally {
		clearInterval(timer);
		clearInterval(choiceTimer);
		signal.removeEventListener('abort', onSignal);
		// No timer starts new work any more; what runs can still start a pass of its own, so drain until nothing is left.
		while (pending.size > 0) await Promise.allSettled([...pending]);
	}
	const reason = stopped ?? { reason: 'signal' };
	await write({ stopped: reason.reason });
	return reason;
}
