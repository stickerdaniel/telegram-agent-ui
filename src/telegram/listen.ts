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
import { admitted, recordFiles, sourceOf } from './inbound.ts';
import { courier, type Inbound, inbound, messageKey, type StoredMessage } from './messages.ts';
import { type InboundUpdate, parseStoredUpdate, type StoredUpdate, updateCourier, type UpdateHandled, updateKey } from './updates.ts';

export type { Inbound, InboundUpdate };

export const LISTEN = { beat: 30_000, pause: 5_000, choices: 3_000 };
export const POLL_TIMEOUT = 50;
export const MISSED_AFTER = 150_000;
export const KEEP_CLOSED = 30 * 86_400_000;
const CLEAN_EVERY = 3_600_000;

const owesHost = (question: Question, at: number): boolean =>
	question.bindingOwed === true || (bindingOf(question) !== undefined && question.shown.recheckAt !== undefined && question.expiresAt !== undefined && at < question.expiresAt);
const CURSOR_AGE = 6 * 86_400_000;
export const CURSOR_KEY = 'cursor';
const UPDATES = ['message', 'callback_query'] as const;
const ALL_UPDATES = ['message', 'edited_message', 'callback_query', 'message_reaction'] as const;

export type Stopped = { reason: 'signal' } | { reason: 'conflict' | 'webhook' | 'token' | 'lease'; message: string };

export type ListenOptions = {
	chat: Chat;
	target: number;
	origin: string;
	call: Transport;
	store: Store;
	allow: number[];
	onMessage?: (message: Inbound) => Promise<void>;
	onUpdate?: (update: InboundUpdate, deadline: number) => Promise<void>;
	signal: AbortSignal;
	labels?: Partial<Labels>;
	push?: { metaKeys: string[] };
	views?: ViewClient;
	now?: () => number;
	log?: (line: string) => void;
};

export type Cursor = { v: 1; origin: string; epoch: number; offset?: number; at: number; refused: number };

export function parseCursor(value: unknown): (Omit<Cursor, 'origin'> & { origin?: string }) | undefined {
	if (!isRecord(value) || value.v !== 1 || !isNat(value.at)) return undefined;
	const { origin, epoch, offset, refused } = value;
	if ((origin !== undefined && !isString(origin)) || (epoch !== undefined && !isNat(epoch)) || (offset !== undefined && !isNat(offset)) || (refused !== undefined && !isNat(refused))) return undefined;
	return { v: 1, ...(origin !== undefined ? { origin } : {}), epoch: epoch ?? 0, ...(offset !== undefined ? { offset } : {}), at: value.at, refused: refused ?? 0 };
}
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
export const isUpdate = (value: unknown): value is Update => isRecord(value) && isNat(value.update_id);

export type ChoicePass = { answered: number; removed: number; left: number };

const byTime = (a: StoredChoice, b: StoredChoice) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function applyChoices(options: { chat: Chat; views: ViewClient; log?: (line: string) => void; stopped?: () => boolean }): Promise<ChoicePass> {
	const { chat, views } = options;
	const log = options.log ?? (() => {});
	const read = await views.choices();
	if (read.kind !== 'ok') throw new Error(`the view host refused to list its choices: ${read.reason}`);
	const pass: ChoicePass = { answered: 0, removed: 0, left: 0 };
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

function stopFor(response: CallResponse): Exclude<Stopped, { reason: 'signal' | 'lease' }> | undefined {
	if ('noAnswer' in response || response.ok) return undefined;
	if (response.status === 409) return { reason: /webhook/i.test(response.description) ? 'webhook' : 'conflict', message: response.description };
	if (response.status === 401) return { reason: 'token', message: response.description };
	return undefined;
}

export async function listen(options: ListenOptions): Promise<Stopped> {
	const { store } = options;
	if (options.push !== undefined && !(isRecord(options.push) && arrayOf(isString)(options.push.metaKeys))) throw new ShapeError('push.metaKeys is not a list of strings');
	if (!arrayOf(isInt)(options.allow)) throw new ShapeError('allow is not a list of user ids');
	if (!isInt(options.target)) throw new ShapeError('target is not a chat id');
	if (!isString(options.origin) || options.origin === '') throw new ShapeError('origin is not a non-empty string');
	const push = options.push && { metaKeys: [...options.push.metaKeys] };
	const allow = [...options.allow];
	let entered = false;
	try {
		return await store.lock(LISTENER_KEY, () => {
			entered = true;
			return run({ ...options, allow }, push);
		});
	} catch (error) {
		if (!entered && error instanceof LockTimeout) return { reason: 'lease', message: `another listener holds this store: ${error.message}` };
		throw error;
	}
}

async function run(options: ListenOptions, push: { metaKeys: string[] } | undefined): Promise<Stopped> {
	const { chat, store, signal } = options;
	const call = (request: Call) => Promise.resolve().then(() => options.call(request)).catch(() => NO_ANSWER);
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => {});
	const labels = mergeLabels(options.labels);
	const { target, origin, allow, onUpdate } = options;
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
	const unlessStopped = <T>(promise: Promise<T>) => Promise.race([promise, ended]);
	const pause = (ms: number) => unlessStopped(new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const tokenStop = (error: unknown): Stopped => ({ reason: 'token', message: describe(error) });

	const pending = new Set<Promise<void>>();
	const track = (task: Promise<void>) => {
		pending.add(task);
		void task.finally(() => pending.delete(task));
	};
	const updates = onUpdate ? updateCourier({ store, onUpdate, log, now, track, ended, stopped: () => stopped !== undefined }) : undefined;

	const previous = parseListener(await store.get(LISTENER_KEY));
	let polled = previous?.polled ?? previous?.heartbeat;
	const record = (extra: { stopped?: string } = {}) => ({ heartbeat: now(), ...(polled !== undefined ? { polled } : {}), ...(push ? { push } : {}), ...extra });
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

	async function keep(update: Update): Promise<void> {
		if (!messages) return;
		const found: unknown = update.message;
		const reply = isRecord(found) && isRecord(found.reply_to_message) && isNat(found.reply_to_message.message_id) ? found.reply_to_message.message_id : undefined;
		const entry = reply === undefined ? undefined : await store.get(indexKey({ chat: target, message: reply }));
		const read = inbound(found, isString(entry) ? entry : undefined);
		if (!read) return log(`the message of update ${update.update_id} has no form onMessage reads; onUpdate gets it as it came`);
		const stored: StoredMessage = { v: 1, chat: target, update: update.update_id, message: read, attempts: 0 };
		const key = messageKey({ chat: target, message: read.message });
		if ((await store.get(key)) === undefined) await store.set(key, stored);
		deliverMessages();
	}

	async function receive(update: Update, handled: UpdateHandled, epoch: number): Promise<void> {
		if (!updates) return;
		const key = updateKey(update, epoch);
		const held = parseStoredUpdate(await store.get(key));
		if (held) return updates.add(held);
		const receipt: StoredUpdate = { v: 1, key, epoch, updateId: update.update_id, update, handled, attempts: 0 };
		await store.set(key, receipt);
		updates.add(receipt);
	}

	async function take(update: Update, epoch: number): Promise<'taken' | 'refused' | 'again'> {
		if (sourceOf(update)?.chat !== target) return 'refused';
		let handled: UpdateHandled;
		try {
			handled = await chat.handle(update);
		} catch (error) {
			if (error instanceof TokenRefused) {
				halt(tokenStop(error));
				return 'again';
			}
			if (!(error instanceof ShapeError)) {
				log(`update ${update.update_id} failed and is fetched again: ${describe(error)}`);
				return 'again';
			}
			log(`update ${update.update_id} breaks its shape: ${error.message}`);
			handled = { error: error.message };
		}
		if ('kind' in handled && handled.kind === 'answered') flush();
		if (!admitted(update, target, allow)) return 'refused';
		try {
			await recordFiles(store, update);
			if ('kind' in handled && handled.kind === 'ignored' && update.message !== undefined) await keep(update);
			await receive(update, handled, epoch);
		} catch (error) {
			log(`update ${update.update_id} was not stored and is fetched again: ${describe(error)}`);
			return 'again';
		}
		return 'taken';
	}

	async function source(cursor: Cursor | undefined): Promise<Cursor> {
		const stored = cursor ?? parseCursor(await store.get(CURSOR_KEY));
		if (stored && stored.origin === origin && now() - stored.at < CURSOR_AGE) return { ...stored, origin };
		const fresh: Cursor = { v: 1, origin, epoch: (stored?.epoch ?? 0) + 1, at: now(), refused: stored?.refused ?? 0 };
		await store.set(CURSOR_KEY, fresh);
		log(`update ids count in epoch ${fresh.epoch} from now on`);
		return fresh;
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
			for (let wait = LISTEN.pause; updates && !stopped; wait = Math.min(wait * 2, LISTEN.beat)) {
				try {
					await updates.start();
					break;
				} catch (error) {
					log(`the stored receipts were not read and are read again: ${describe(error)}`);
					await pause(wait);
				}
			}
			cleaning();
			pick();
		}
		let cursor: Cursor | undefined;
		while (!stopped) {
			try {
				cursor = await source(cursor);
			} catch (error) {
				log(`the cursor was not read or stored: ${describe(error)}`);
				await pause(LISTEN.pause);
				continue;
			}
			const { offset } = cursor;
			const missed = polled !== undefined && now() - polled > MISSED_AFTER;
			const payload = { ...(offset !== undefined ? { offset } : {}), timeout: missed ? 0 : POLL_TIMEOUT, allowed_updates: [...(onUpdate ? ALL_UPDATES : UPDATES)] };
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
			const fetched = Array.isArray(response.result) ? response.result : undefined;
			if (!fetched?.every(isUpdate)) {
				log('getUpdates answered with no list of updates');
				await pause(LISTEN.pause);
				continue;
			}
			if (missed) await notice().catch((error: unknown) => log(`the notice about missed taps failed: ${describe(error)}`));
			polled = now();
			beat();
			let taken = true;
			for (const update of fetched) {
				const current: Cursor = cursor;
				const result = stopped ? 'again' : await take(update, current.epoch);
				if (result === 'again') {
					taken = false;
					break;
				}
				const next: Cursor = { ...current, offset: update.update_id + 1, at: now(), refused: current.refused + (result === 'refused' ? 1 : 0) };
				try {
					await store.set(CURSOR_KEY, next);
					cursor = next;
				} catch (error) {
					log(`the cursor was not stored: ${describe(error)}`);
					taken = false;
					break;
				}
			}
			if (!stopped && !taken) await pause(LISTEN.pause);
		}
	} finally {
		clearInterval(timer);
		clearInterval(choiceTimer);
		updates?.stop();
		signal.removeEventListener('abort', onSignal);
		while (pending.size > 0) await Promise.allSettled([...pending]);
	}
	const reason = stopped ?? { reason: 'signal' };
	await write({ stopped: reason.reason });
	return reason;
}
