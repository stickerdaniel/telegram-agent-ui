// `createChat` composes the pure core with a transport and a store. It holds no durable state:
// every method that touches a question takes the store's lock of `q:<ref>`, loads the question
// through `parseQuestion`, applies one event with `reduce`, stores the result and only then runs
// the effects. What must survive a crash is derived from the stored question, never queued:
// `shown.want` above `shown.done` owes an edit, `seq` above `delivery.seq` owes a delivery, and
// `flush` pays both.
import { arrayOf, isInt, isRecord, isString, optional, sameJson } from '../core/check.ts';
import { classify } from '../core/classify.ts';
import { isBody, isSent } from '../core/guards.ts';
import { mergeLabels } from '../core/labels.ts';
import { parseQuestion } from '../core/parse.ts';
import { locate, RECHECK_DELAY, reduce } from '../core/reduce.ts';
import { kindOf, render, renderEdit } from '../core/render.ts';
import { isOrigin, REF, VIEW_ID } from '../core/shape.ts';
import {
	type Answer,
	type Body,
	type Call,
	type CallClass,
	type CallResponse,
	type Handled,
	type Json,
	type Labels,
	type Outcome,
	type Publishable,
	type Question,
	type QuestionEvent,
	type Readable,
	type Sent,
	ShapeError,
	type Spec,
	type Step,
	type Store,
	TokenRefused,
	type Update,
	type User,
	type ViewClient,
	type Warning,
} from '../core/types.ts';
import { DEADLINES, deadlineOf, messageIds, NO_ANSWER, paced, RETRY_WINDOW, replyingTo, START_WINDOW, sleep, within } from './calls.ts';
import { DELIVERY_ATTEMPTS, LISTENER_KEY, listenerStatus, readRenewed, renew, spent } from './listener.ts';

/** What `onAnswer` receives: the answer as `handle` reported it, with `delivery: '<ref>:<seq>'` as its idempotency key. */
export type Delivered = Extract<Handled, { kind: 'answered' }> & { delivery: string };

export type ChatIO = {
	/** The transport. `files` holds the opened files of a files step by multipart field. */
	call: (call: Call, files?: Record<string, Publishable>) => Promise<CallResponse>;
	store: Store;
	chat: number;
	/** User ids that may answer. Default: [chat]. */
	allow?: number[];
	labels?: Partial<Labels>;
	/** Default Date.now. */
	now?: () => number;
	/** Without it a spec with a view is refused. */
	viewOrigin?: string;
	/**
	 * The client of the view host at `viewOrigin`. With it, a question with a view gets its body
	 * shown in the view, and an option's tab is checked against the view's tabs.
	 */
	views?: ViewClient;
	/** The file reader `attach` goes through. Without it a spec with `attach` is refused. */
	files?: (paths: string[]) => Promise<Readable>;
	/** Bytes per non-photo file: 50,000,000 by default for the cloud Bot API, 2,000,000,000 for a local server. */
	fileLimit?: number;
	/** An owner's rules: a returned string refuses the send with it. */
	guards?: ((spec: Spec) => string | undefined)[];
	/** Called by `flush`, outside the lock, for every answer not delivered yet. */
	onAnswer?: (answer: Delivered) => Promise<void>;
};

export type SendOptions = { ref?: string; topic?: number; meta?: Json; expiresAt?: number; strict?: boolean; dryRun?: boolean; needsListener?: boolean };
export type Waited = { status: 'pending' | 'answered' | 'closed'; answer?: Answer; by?: User; listener: { alive: boolean; stopped?: string } };

export type Chat = {
	send(spec: Spec, options?: SendOptions): Promise<Outcome>;
	edit(sent: Sent, body: Body): Promise<Outcome>;
	close(ref: string, body?: Body): Promise<Outcome>;
	handle(update: Update): Promise<Handled>;
	wait(ref: string, options?: { seconds?: number }): Promise<Waited>;
	flush(options?: { restart?: boolean }): Promise<void>;
	get(ref: string): Promise<Question | undefined>;
	updates: readonly ['message', 'callback_query'];
};

type Refused = Extract<Outcome, { kind: 'refused' }>;

/** After this many rejected deliveries an answer counts as undelivered until its seq rises or `flush({ restart: true })` renews it. */
export { DELIVERY_ATTEMPTS };
/** The key of an answer's delivery and of its renewed baseline: `<ref>:<seq>`. */
export const deliveryKey = (question: Pick<Question, 'ref' | 'seq'>) => `${question.ref}:${question.seq}`;
/** `wait` in seconds: its default and its most. */
export const WAIT_SECONDS = { default: 10, most: 50 } as const;
const WAIT_POLL = 200;
/** Size limits before a request, in bytes: a photo, and by default any other file on the cloud Bot API. The server's answer stays the authority. */
const LIMITS = { photo: 10_000_000, file: 50_000_000 } as const;
const UPDATES = ['message', 'callback_query'] as const;
const OK: CallClass = { kind: 'ok', result: null };
const REF_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** The store keys of 4.5: a question, the tombstone of a deleted one, and the reply index entry of a message. */
export const questionKey = (ref: string) => `q:${ref}`;
export const tombstoneKey = (ref: string) => `t:${ref}`;
export const indexKey = (at: { chat: number; message: number }) => `m:${at.chat}:${at.message}`;

const refused = (code: Refused['code'], reason: string): Refused => ({ kind: 'refused', code, reason });
const sentOf = (question: Question): Sent | undefined => ('sent' in question ? question.sent : undefined);
const statusOf = (question: Question) => (question.status === 'answered' || question.status === 'closed' ? question.status : 'pending');
const isQuestionSpec = (spec: Spec): spec is Question['spec'] => spec.answer !== undefined;
/** The question with `shown.recheckAt` set to `recheckAt`, or without one. */
function withRecheck(question: Question, recheckAt: number | undefined): Question {
	const { recheckAt: _recheckAt, ...shown } = question.shown;
	return { ...question, shown: recheckAt === undefined ? shown : { ...shown, recheckAt } };
}
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500) || 'no reason given';

/** A ShapeError as the refusal `shape`. Any other error is rethrown. */
function shapeRefusal(error: unknown): Refused {
	if (error instanceof ShapeError) return refused('shape', error.message);
	throw error;
}

/** 8 random characters of [a-z2-7]. */
function newRef(): string {
	return [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => REF_ALPHABET.charAt(byte % 32)).join('');
}

/** Closes each opened file once, two opens of one path included. A file that fails to close changes no outcome. */
async function closeAll(files: Publishable[]): Promise<void> {
	await Promise.allSettled([...new Set(files)].map((file) => file.close()));
}

/** Why a files step failed, for `partial`. */
function failure(result: CallClass): { class: 'refused' | 'uncertain'; reason: string } {
	if (result.kind === 'refused') return { class: 'refused', reason: result.reason };
	if (result.kind === 'retry') return { class: 'refused', reason: `the server asked to wait longer than ${RETRY_WINDOW / 1000} s` };
	if (result.kind === 'unchanged') return { class: 'refused', reason: 'the server answered as if to an edit' };
	return { class: 'uncertain', reason: 'the files step got no answer' };
}

/**
 * The composition: send, edit and close messages and questions, take updates, wait for answers
 * and repair what a crash left. It holds no durable state, so any number of processes may share
 * one store. Throws ShapeError for a chat, allow list, view origin, file limit or labels that
 * break their type. A method whose call answers 401 stores what it already decided and rejects
 * with TokenRefused; `send` of a message that never went out returns `refused: token` instead.
 *
 *   const chat = createChat({ call, store: fileStore(dir), chat: 111 });
 *   const outcome = await chat.send(yesNo({ markdown: 'Deploy now?' }));
 *   // In the listener: `await chat.flush({ restart: true })` at start, per update
 *   // `await chat.handle(update)`, and `await chat.flush()` every 30 s and after an update that
 *   // `handle` reports as answered. It stops on TokenRefused.
 */
export function createChat(io: ChatIO): Chat {
	const { store, chat } = io;
	if (!isInt(chat)) throw new ShapeError('chat is not an integer');
	const allow = io.allow ?? [chat];
	if (!arrayOf(isInt)(allow)) throw new ShapeError('allow is not a list of user ids');
	if (io.viewOrigin !== undefined && !isOrigin(io.viewOrigin)) throw new ShapeError(`the view origin "${io.viewOrigin}" is not an https origin`);
	const fileLimit = io.fileLimit ?? LIMITS.file;
	if (!isInt(fileLimit) || fileLimit < 1) throw new ShapeError('fileLimit is not a positive number of bytes');
	const labels = mergeLabels(io.labels);
	const now = io.now ?? Date.now;
	const origin = io.viewOrigin !== undefined ? { viewOrigin: io.viewOrigin } : {};
	const viewOf = (spec: Spec) => (spec.view !== undefined && io.viewOrigin !== undefined ? { view: { id: spec.view, origin: io.viewOrigin } } : {});

	/** One event against one question at the current time. */
	const apply = (question: Question, event: QuestionEvent): Question => reduce(question, event, { now: now(), labels }).question ?? question;

	/** The stored question of `ref`. `held` tells a stored value that does not parse from no value at all. */
	async function load(ref: string): Promise<{ question: Question | undefined; held: boolean }> {
		const value = await store.get(questionKey(ref));
		return { question: parseQuestion(value), held: value !== undefined };
	}

	/** Stores `next` unless it equals `previous`. A question that would not read back after a JSON round trip is never stored. */
	async function save(previous: Question | undefined, next: Question): Promise<Question> {
		if (previous && sameJson(previous, next)) return next;
		const read = parseQuestion(JSON.parse(JSON.stringify(next)));
		if (!read || !sameJson(read, next)) throw new Error(`question ${next.ref} would not read back from the store`);
		await store.set(questionKey(next.ref), next);
		return next;
	}

	/** A refused send: the tombstone first and the delete second, so the ref is never free again. */
	async function bury(ref: string): Promise<void> {
		await store.set(tombstoneKey(ref), { v: 1, at: now() });
		await store.delete(questionKey(ref));
	}

	/** Writes the reply index entry of a question's message when it is missing. */
	async function index(question: Question): Promise<void> {
		const sent = sentOf(question);
		if (sent && (await store.get(indexKey(sent))) !== question.ref) await store.set(indexKey(sent), question.ref);
	}

	/** Writes the index entry of every stored question that has a message. */
	async function rebuildIndex(): Promise<void> {
		for (const key of await store.list('q:')) {
			const question = parseQuestion(await store.get(key));
			if (question) await index(question);
		}
	}

	/** The ref the reply index names for a message, after a rebuild when it names none. */
	async function indexed(at: { chat: number; message: number }): Promise<string | undefined> {
		const entry = await store.get(indexKey(at));
		if (isString(entry)) return entry;
		await rebuildIndex();
		const rebuilt = await store.get(indexKey(at));
		return isString(rebuilt) ? rebuilt : undefined;
	}

	/** The transport, called synchronously. A transport that throws or rejects counts as one without an answer. */
	function invoke(call: Call, files?: Record<string, Publishable>): Promise<CallResponse> {
		try {
			return io.call(call, files).catch(() => NO_ANSWER);
		} catch {
			return Promise.resolve(NO_ANSWER);
		}
	}

	/**
	 * One call, through the pacing gate of its chat when it sends or edits, with its deadline from
	 * the moment the transport is called. A call past its deadline counts as one without an answer.
	 */
	async function request(call: Call, files?: Record<string, Publishable>): Promise<CallClass> {
		const response = await paced(call, () => within(invoke(call, files), deadlineOf(call), NO_ANSWER));
		return classify(call.method, response);
	}

	/**
	 * `request` for an edit whose mark is stored. The time is read in the step that calls the
	 * transport: it is the call's `start`, and a call admitted after `startBy` is not sent, which
	 * returns undefined. So a call never starts later than its mark allowed for.
	 */
	async function requestMarked(call: Call, startBy: number): Promise<{ result: CallClass; start: number } | undefined> {
		let start = 0;
		const response = await paced(call, () => {
			start = now();
			return start > startBy ? Promise.resolve(undefined) : within(invoke(call), deadlineOf(call), NO_ANSWER);
		});
		return response && { result: classify(call.method, response), start };
	}

	/** Rejects with TokenRefused for a 401: the caller has stored what it decided before the call. */
	function unlessToken(result: CallClass): CallClass {
		if (result.kind === 'refused' && result.code === 'token') throw new TokenRefused(`the server refused the bot token: ${result.reason}`);
		return result;
	}

	/** `request`, once more when a 429 allows a retry within RETRY_WINDOW. */
	async function requestRetrying(call: Call, files?: Record<string, Publishable>): Promise<CallClass> {
		const first = await request(call, files);
		if (first.kind !== 'retry') return first;
		const wait = (first.at ?? now()) - now();
		if (wait > RETRY_WINDOW) return first;
		await sleep(Math.max(0, wait));
		return request(call, files);
	}

	/**
	 * Why a question's options name a tab its view lacks, read through `views.has`, or undefined.
	 * Without `views`, or without an option that names a tab, there is nothing to read. Nothing
	 * is sent before this check, so a host that gives no answer refuses too.
	 */
	async function tabRefusal(spec: Spec): Promise<Refused | undefined> {
		const { views } = io;
		const view = spec.view;
		const tabs = spec.answer?.type === 'choice' ? spec.answer.options.flatMap((option) => (option.tab !== undefined ? [option.tab] : [])) : [];
		if (view === undefined || !views || tabs.length === 0) return undefined;
		const found = await within(
			Promise.resolve()
				.then(() => views.has(view))
				.catch(() => undefined),
			DEADLINES.call,
			undefined,
		);
		if (!found) return refused('server', `the view host gave no answer about the view ${view}`);
		if (found.kind === 'refused') return refused('server', `the view host refused to read the view ${view}: ${found.reason}`);
		if (found.kind === 'missing') return refused('shape', `the view ${view} is not on the view host`);
		const lacking = tabs.find((tab) => !found.tabs.includes(tab));
		return lacking === undefined ? undefined : refused('shape', `the view ${view} has no tab "${lacking}", its tabs are ${found.tabs.map((tab) => `"${tab}"`).join(', ')}`);
	}

	/**
	 * Stores a question's body as its view's context, as a call class, so `shown` covers it like
	 * an edit. A context belongs to the host its question's button opens, and `views` is the
	 * client of the configured origin. A question whose stored origin is another one, since the
	 * configured origin moved after its ask, gets no write: the answer is a refusal, so `shown`
	 * counts the message as shown and the outcome carries `not-shown`, since the old host keeps
	 * whatever context it had.
	 */
	async function writeContext(question: Question): Promise<CallClass> {
		const { views } = io;
		const view = question.spec.view;
		if (view === undefined || !views) return OK;
		if (question.viewOrigin !== io.viewOrigin) {
			return { kind: 'refused', code: 'server', reason: `the view button opens ${question.viewOrigin ?? 'no origin'}, and the view client writes to ${io.viewOrigin ?? 'no origin'}: the context there stays as it was` };
		}
		const answer = await within(
			Promise.resolve()
				.then(() => views.context(view, question.ref, question.spec.body))
				.catch(() => undefined),
			DEADLINES.call,
			undefined,
		);
		if (!answer) return { kind: 'uncertain' };
		if (answer.kind === 'ok') return OK;
		return { kind: 'refused', code: 'server', reason: answer.kind === 'missing' ? `the view ${view} is missing on the view host` : answer.reason };
	}

	/**
	 * Pays the edit a question owes: `renderEdit`, then the view's context, then `shown`. With
	 * `recheck`, a question whose `shown.recheckAt` has come gets the same edit once more, which
	 * confirms that no late edit replaced the message. A question without a known message, or
	 * whose 429 time lies ahead, keeps its debt for `flush`.
	 *
	 * The window in which a late request is repaired ends RECHECK_DELAY after the call's deadline,
	 * counted from the call's start S: at S + deadline + 60 s. The clock at the start fixes it, so
	 * an event loop that delivers the timeout late does not move it.
	 *
	 * Before the call goes out, the store marks it as possibly outstanding: `recheckAt` moves to
	 * the mark's time M plus START_WINDOW, the call's deadline and the recheck delay. A call that
	 * cannot start within START_WINDOW of its mark is not sent, so S <= M + START_WINDOW and the
	 * mark lies at or past the window's end. A process that dies or a write that fails after the
	 * call therefore still leaves a recheck that comes late enough. An uncertain answer sets
	 * `recheckAt` to the later of 60 s after that answer and the window's end. An answer that is
	 * not uncertain shows that the call is over, and the mark gives way to the `recheckAt` from
	 * before it. A call that was not sent counts as a failed edit: `failures` rises, the debt
	 * stays, and the mark gives way too.
	 */
	async function show(question: Question, recheck = false): Promise<Question> {
		const sent = sentOf(question);
		const { want, done, retryAt, recheckAt: before } = question.shown;
		const due = want > done || (recheck && before !== undefined && before <= now());
		if (!sent || !due || (retryAt !== undefined && retryAt > now())) return question;
		let call: Call;
		try {
			call = renderEdit(question, labels);
		} catch (error) {
			// A body that cannot go out counts as refused.
			return save(question, apply(question, { type: 'shown', want, outcome: { kind: 'refused', code: 'server', reason: shapeRefusal(error).reason } }));
		}
		const startBy = now() + START_WINDOW;
		const mark = startBy + deadlineOf(call) + RECHECK_DELAY;
		const marked = await save(question, withRecheck(question, mark));
		const started = await requestMarked(call, startBy);
		if (!started) {
			// Nothing went out. `reduce` counts it as an edit without an answer; no recheck is owed for it.
			return save(marked, withRecheck(apply(marked, { type: 'shown', want, outcome: { kind: 'uncertain' } }), before));
		}
		let outcome = unlessToken(started.result);
		if (outcome.kind === 'ok' || outcome.kind === 'unchanged') outcome = await writeContext(marked);
		let next = apply(marked, { type: 'shown', want, outcome });
		if (outcome.kind === 'uncertain') {
			const windowEnd = started.start + deadlineOf(call) + RECHECK_DELAY;
			next = withRecheck(next, Math.max(next.shown.recheckAt ?? 0, windowEnd));
		} else if (next.shown.recheckAt === mark) next = withRecheck(next, before);
		return save(marked, next);
	}

	/** The warnings of a stored state: no known message, or a message whose edit the server refused. */
	function stateWarnings(question: Question): Warning[] {
		const warnings: Warning[] = [];
		if (!sentOf(question)) warnings.push({ code: 'unconfirmed-message', message: `no message of question ${question.ref} is known: the first tap on its buttons reveals it` });
		if (question.shown.error !== undefined) warnings.push({ code: 'not-shown', message: `the message does not show the state of question ${question.ref}: ${question.shown.error}` });
		return warnings;
	}

	/** The outcome of an operation that changed a question: `ok`, with the warnings of its state after `warnings`. */
	function stated(question: Question, warnings: Warning[] = []): Outcome {
		const sent = sentOf(question);
		return { kind: 'ok', ...(sent ? { sent } : {}), ref: question.ref, status: statusOf(question), warnings: [...warnings, ...stateWarnings(question)] };
	}

	/**
	 * Opens every attachment through `io.files` and checks its size, before anything is sent.
	 * Every handle the reader returns joins `owned`, which the caller closes once whatever the
	 * outcome. The map names one handle per path, the first returned for it, and every multipart
	 * field of that path sends it: so each attachment's limit is checked on that handle.
	 */
	async function open(spec: Spec, owned: Publishable[]): Promise<{ kind: 'ok'; files: Map<string, Publishable> } | Refused> {
		const attach = spec.attach ?? [];
		const files = new Map<string, Publishable>();
		if (attach.length === 0) return { kind: 'ok', files };
		if (!io.files) return refused('shape', 'attach needs a file reader, and createChat was given none');
		const read = await io.files(attach.map((file) => file.path));
		if (read.kind === 'refused') return refused(read.code, read.reason);
		owned.push(...read.files);
		for (const [index, file] of attach.entries()) {
			const opened = read.files[index];
			if (!opened) return refused('shape', `the file reader returned no file for ${file.path}`);
			if (!files.has(file.path)) files.set(file.path, opened);
		}
		for (const file of attach) {
			const selected = files.get(file.path);
			const limit = kindOf(file) === 'photo' ? LIMITS.photo : fileLimit;
			if (selected && selected.size > limit) return refused('shape', `${file.path} has ${selected.size} bytes, more than ${limit}`);
		}
		return { kind: 'ok', files };
	}

	/**
	 * Sends the files steps after the body, each as a reply to the body's message, and stops at
	 * the first that fails. `keep` stores the file ids of each step that arrived. A 401 rejects
	 * with TokenRefused once the ids before it are kept.
	 */
	async function sendFiles(steps: Step[], files: Map<string, Publishable>, body: Sent, keep: (sent: Sent) => Promise<void>): Promise<{ sent: Sent; failed?: Extract<Outcome, { kind: 'partial' }>['failed'] }> {
		let sent = body;
		for (const [index, step] of steps.entries()) {
			if (step.role !== 'files') continue;
			const call = replyingTo(step.call, body.message);
			const opened: Record<string, Publishable> = {};
			for (const { field, path } of call.files ?? []) {
				const file = files.get(path);
				if (file) opened[field] = file;
			}
			const result = unlessToken(await requestRetrying(call, opened));
			const ids = result.kind === 'ok' ? messageIds(result.result) : undefined;
			if (!ids) return { sent, failed: { step: index, ...failure(result) } };
			sent = { ...sent, files: [...sent.files, ...ids] };
			await keep(sent);
		}
		return { sent };
	}

	/** A body step that sent no message, as a refusal: the server refused it, or a 429 asked to wait too long. */
	function unsent(result: Exclude<CallClass, { kind: 'ok' | 'uncertain' }>): Refused {
		if (result.kind === 'refused') return refused(result.code, result.reason);
		if (result.kind === 'retry') return refused('busy', `the server asked to wait longer than ${RETRY_WINDOW / 1000} s`);
		return refused('server', 'the server answered the send as if it were an edit');
	}

	/** Sends a message that asks nothing. No store is touched. */
	async function post(spec: Spec, steps: Step[], warnings: Warning[], topic: number | undefined): Promise<Outcome> {
		const [body] = steps;
		if (!body) throw new Error('render returned no body step');
		const owned: Publishable[] = [];
		try {
			const opened = await open(spec, owned);
			if (opened.kind === 'refused') return opened;
			const result = await requestRetrying(body.call);
			const message = result.kind === 'ok' ? messageIds(result.result)?.[0] : undefined;
			if (message === undefined) return result.kind === 'ok' || result.kind === 'uncertain' ? { kind: 'uncertain', reason: 'the body got no answer, it may have arrived' } : unsent(result);
			const sent: Sent = { chat, ...(topic !== undefined ? { topic } : {}), message, files: [], ...viewOf(spec) };
			const done = await sendFiles(steps, opened.files, sent, async () => {});
			return done.failed ? { kind: 'partial', sent: done.sent, failed: done.failed, warnings } : { kind: 'ok', sent: done.sent, warnings };
		} finally {
			await closeAll(owned);
		}
	}

	/**
	 * Sends a question. Under its lock, a held ref answers from the stored question before any
	 * check that only a new send needs: the expiry, the listener, the view's tabs, the files. A
	 * new question is stored as `sending`, gets its view's context, its body, `sent` and its
	 * reply index. The
	 * files go out after the lock, so a long upload never holds a tap back. The outcome reports
	 * the question as the store holds it after the last step.
	 */
	async function ask(asked: Question, steps: Step[], warnings: Warning[], needsListener: boolean): Promise<Outcome> {
		const { ref } = asked;
		const [body] = steps;
		if (!body) throw new Error('render returned no body step');
		const owned: Publishable[] = [];
		try {
			const first = await store.lock(questionKey(ref), async (): Promise<Outcome | { kind: 'sent'; sent: Sent; shown: Question; files: Map<string, Publishable> }> => {
				if ((await store.get(tombstoneKey(ref))) !== undefined) return refused('ref-conflict', `the ref ${ref} belonged to a question that is gone`);
				const { question: held, held: taken } = await load(ref);
				if (taken) return held && sameJson(held.spec, asked.spec) ? stated(held, warnings) : refused('ref-conflict', `the ref ${ref} belongs to another question`);
				if (asked.status === 'closed') return refused('closed', 'expiresAt has passed');
				if (needsListener && !listenerStatus(await store.get(LISTENER_KEY), now()).alive) return refused('no-listener', 'no listener is alive to receive the answer');
				const lacking = await tabRefusal(asked.spec);
				if (lacking) return lacking;
				const opened = await open(asked.spec, owned);
				if (opened.kind === 'refused') return opened;
				let question = await save(undefined, asked);
				if ((await writeContext(question)).kind !== 'ok') {
					// An edit to the same body owes a repair, which writes the context again once the message is known.
					question = await save(question, apply(question, { type: 'edit', body: question.spec.body }));
				}
				const result = await requestRetrying(body.call);
				const message = result.kind === 'ok' ? messageIds(result.result)?.[0] : undefined;
				if (message === undefined) {
					if (result.kind !== 'ok' && result.kind !== 'uncertain') {
						await bury(ref);
						return unsent(result);
					}
					const reason =
						question.spec.answer.type === 'text'
							? 'the body got no answer: a text question without a known message cannot receive its answer, close it'
							: 'the body got no answer: the question stays sending until a tap on its buttons reveals its message';
					return { kind: 'uncertain', ref, reason };
				}
				const sent: Sent = { chat, ...(question.topic !== undefined ? { topic: question.topic } : {}), message, files: [], ref, ...viewOf(question.spec) };
				try {
					question = await save(question, apply(question, { type: 'sent', sent }));
					await store.set(indexKey(sent), ref);
					question = await show(question);
				} catch (error) {
					if (error instanceof TokenRefused) throw error;
					return { kind: 'uncertain', ref, reason: `message ${message} was sent, and storing it failed: ${describe(error)}` };
				}
				return { kind: 'sent', sent, shown: question, files: opened.files };
			});
			if (first.kind !== 'sent') return first;
			let latest = first.shown;
			const done = await sendFiles(steps, first.files, first.sent, async (sent) => {
				// Best effort, as 4.4 states for files: the outcome carries the ids, and a store that fails here leaves sent.files short.
				await store
					.lock(questionKey(ref), async () => {
						const { question } = await load(ref);
						if (question) latest = await save(question, apply(question, { type: 'sent', sent }));
					})
					.catch(() => {});
			});
			const all = [...warnings, ...stateWarnings(latest)];
			return done.failed ? { kind: 'partial', sent: done.sent, ref, failed: done.failed, warnings: all } : { kind: 'ok', sent: done.sent, ref, status: statusOf(latest), warnings: all };
		} finally {
			await closeAll(owned);
		}
	}

	/**
	 * Sends a spec. Shape, `strict` and guards refuse before the store is read; a question then
	 * goes to `ask`, which answers a held ref from the store before the checks of a new send. A
	 * question's `ref` is unique for the life of the store: a held ref with an equal spec sends
	 * nothing and returns what the question says.
	 */
	async function send(spec: Spec, options: SendOptions = {}): Promise<Outcome> {
		const { topic, meta, expiresAt, strict, dryRun, needsListener } = options;
		if (!isRecord(spec)) return refused('shape', 'the spec is not an object');
		if (!optional(isInt)(topic)) return refused('shape', 'the topic is not an integer');
		const asks = isQuestionSpec(spec);
		if (!asks && (options.ref !== undefined || meta !== undefined || expiresAt !== undefined)) return refused('shape', 'ref, meta and expiresAt belong to a question, and the spec has no answer');
		const ref = asks ? (options.ref ?? newRef()) : undefined;
		let rendered: { steps: Step[]; warnings: Warning[] };
		try {
			rendered = render(spec, { chat, ...(topic !== undefined ? { topic } : {}), ...(ref !== undefined ? { ref } : {}), ...origin, labels });
		} catch (error) {
			return shapeRefusal(error);
		}
		const { steps, warnings } = rendered;
		if (strict && warnings.length > 0) return refused('shape', `strict: ${warnings.map((warning) => warning.message).join('; ')}`);
		for (const guard of io.guards ?? []) {
			const reason = guard(spec);
			if (reason !== undefined) return refused('guard', reason);
		}
		let asked: Question | undefined;
		if (asks && ref !== undefined) {
			try {
				asked = reduce(
					undefined,
					{ type: 'ask', spec, ref, chat, allow, ...origin, ...(topic !== undefined ? { topic } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}), ...(meta !== undefined ? { meta } : {}) },
					{ now: now(), labels },
				).question;
			} catch (error) {
				return shapeRefusal(error);
			}
			if (!asked) throw new Error('ask left no question');
		}
		if (dryRun) return { kind: 'dry', steps, warnings };
		return asked ? ask(asked, steps, warnings, needsListener === true) : post(spec, steps, warnings, topic);
	}

	/**
	 * A new body for a message that is no question's. Best effort and stateless: nothing repairs an
	 * uncertain edit. The view row comes from the caller's `Sent`, so a view of another origin than
	 * the configured one is refused as `origin`.
	 */
	async function editPlain(sent: Sent, body: Body): Promise<Outcome> {
		if (sent.view && sent.view.origin !== io.viewOrigin) return refused('origin', `the view origin ${sent.view.origin} is not the configured one`);
		if (sent.view && !VIEW_ID.test(sent.view.id)) return refused('shape', `the view id "${sent.view.id}" is not 22 base64url characters`);
		let call: Call;
		try {
			call = renderEdit({ sent, body }, labels);
		} catch (error) {
			return shapeRefusal(error);
		}
		const result = unlessToken(await requestRetrying(call));
		if (result.kind === 'ok' || result.kind === 'unchanged') return { kind: 'ok', sent, warnings: [] };
		if (result.kind === 'uncertain') return { kind: 'uncertain', reason: 'the edit got no answer, it may have arrived' };
		return unsent(result);
	}

	/**
	 * A new body for a sent message. A message is a question's when its `Sent` names a ref or the
	 * reply index names it, after a rebuild, so a lost index entry never strips a question's
	 * buttons. On a question the edit is the event `edit` under its lock, and the view row comes
	 * from the stored question: the origin its `ask` stored stays, even after the configured one
	 * moved, and the view of the caller's `Sent` is never read. On a plain message the view of the
	 * `Sent` must name the configured origin, so no caller points a view button at another site.
	 */
	async function edit(sent: Sent, body: Body): Promise<Outcome> {
		if (!isSent(sent)) return refused('shape', 'the sent message breaks its type');
		if (sent.chat !== chat) return refused('chat', `the message is in chat ${sent.chat}, and this chat is ${chat}`);
		if (!isBody(body)) return refused('shape', 'the body breaks its type');
		const ref = sent.ref ?? (await indexed(sent));
		if (ref === undefined) return editPlain(sent, body);
		if (!REF.test(ref)) return refused('shape', `the ref "${ref}" is not 1 to 32 characters of [A-Za-z0-9_-]`);
		return store.lock(questionKey(ref), async () => {
			const { question } = await load(ref);
			if (!question) return refused('unknown-ref', `no question ${ref} is stored`);
			const known = sentOf(question);
			if (known && known.message !== sent.message) return refused('unknown-ref', `message ${sent.message} is not the message of question ${ref}`);
			if (question.status === 'closed') return refused('closed', `question ${ref} is closed`);
			let next: Question;
			try {
				next = apply(question, { type: 'edit', body });
			} catch (error) {
				return shapeRefusal(error);
			}
			return stated(await show(await save(question, next)));
		});
	}

	/**
	 * Ends a question, with `body` as its resolved form. The status is stored before the edit, so
	 * a crash never leaves a resolved message over a question that still takes answers. A second
	 * close replaces the resolved body and pays an edit the first one still owes. The view row
	 * keeps the origin the question's `ask` stored.
	 */
	async function close(ref: string, body?: Body): Promise<Outcome> {
		if (!isString(ref) || !REF.test(ref)) return refused('shape', `the ref "${String(ref)}" is not 1 to 32 characters of [A-Za-z0-9_-]`);
		if (body !== undefined && !isBody(body)) return refused('shape', 'the body breaks its type');
		return store.lock(questionKey(ref), async () => {
			const { question } = await load(ref);
			if (!question) return refused('unknown-ref', `no question ${ref} is stored`);
			let next: Question;
			try {
				next = apply(question, { type: 'close', ...(body !== undefined ? { body } : {}) });
			} catch (error) {
				return shapeRefusal(error);
			}
			return stated(await show(await save(question, next)));
		});
	}

	/**
	 * One update from Telegram. A tap finds its question by the ref in its callback data. A reply
	 * finds it by the reply index, then by the ref of the replied-to message's buttons, then by
	 * the index after a rebuild. A message whose question became known joins the index, so after
	 * `handle` the entry `m:<chat>:<replied-to id>` names the ref of every reply that belongs to a
	 * question: a listener reads it for `onMessage`. Rejects with ShapeError for an update whose
	 * fields break their types.
	 */
	async function handle(update: Update): Promise<Handled> {
		const at = locate(update);
		if (!at) return { kind: 'ignored' };
		let ref: string | undefined;
		if ('button' in at) ref = at.ref;
		else {
			const entry = await store.get(indexKey({ chat: at.chat, message: at.replyTo }));
			ref = isString(entry) ? entry : (at.ref ?? (await indexed({ chat: at.chat, message: at.replyTo })));
		}
		if (ref === undefined || !REF.test(ref)) return { kind: 'ignored' };
		const key = questionKey(ref);
		return store.lock(key, async () => {
			const { question } = await load(ref);
			const result = reduce(question, { type: 'input', update }, { now: now(), labels });
			const current = result.question ? await save(question, result.question) : undefined;
			if (current) await index(current);
			// A toast and a reaction are safe to lose: their answers are dropped, except a 401.
			for (const call of result.calls) unlessToken(await request(call));
			if (current) await show(current);
			return result.handled ?? { kind: 'ignored' };
		});
	}

	/** What `onAnswer` gets for a question's current answer. */
	function delivered(question: Question): Delivered | undefined {
		if (question.status !== 'answered' && question.status !== 'closed') return undefined;
		const { ref, seq, answer, by, answeredAt, previous, meta } = question;
		if (!answer || !by || answeredAt === undefined) return undefined;
		return { kind: 'answered', ref, seq, answer, by, at: answeredAt, ...(previous ? { previous } : {}), ...(meta !== undefined ? { meta } : {}), delivery: deliveryKey(question) };
	}

	/**
	 * The baselines of the delivery budgets, from the listener record, where `info` reads them too.
	 * A restart pass first renews every owed answer whose budget is spent. Stored attempts keep
	 * counting, so `info` sees every rejection.
	 */
	async function baselines(restart: boolean): Promise<Record<string, number>> {
		if (!restart) return (await readRenewed(store)).answers;
		const owed: { key: string; attempts: number }[] = [];
		for (const key of await store.list('q:')) {
			const question = parseQuestion(await store.get(key));
			if (question && question.delivery.seq < question.seq) owed.push({ key: deliveryKey(question), attempts: question.delivery.attempts });
		}
		return (await renew(store, 'answers', owed)).answers;
	}

	/**
	 * Under the question's lock: finishes the delete of a question whose tombstone exists, closes
	 * it past expiresAt, writes its index entry, pays or rechecks its edit and names the answer it
	 * owes, unless its budget since `baseline` is spent.
	 */
	async function repair(ref: string, baseline: Record<string, number>): Promise<Delivered | undefined> {
		if ((await store.get(tombstoneKey(ref))) !== undefined) {
			// A refused send wrote the tombstone and failed before the delete.
			await store.delete(questionKey(ref));
			return undefined;
		}
		const loaded = (await load(ref)).question;
		if (!loaded) return undefined;
		let question = loaded;
		if (question.expiresAt !== undefined && question.status !== 'closed' && now() >= question.expiresAt) {
			// `reduce` closes a question past expiresAt before any event. A delivered event of the seq already delivered changes nothing else.
			question = await save(question, apply(question, { type: 'delivered', seq: question.delivery.seq }));
		}
		await index(question);
		question = await show(question, true);
		const owed = question.delivery.seq < question.seq && !spent(question.delivery.attempts, baseline[deliveryKey(question)]);
		return io.onAnswer && owed ? delivered(question) : undefined;
	}

	/** Calls `onAnswer` outside the lock, then applies `delivered` under it. */
	async function deliver(answer: Delivered, onAnswer: (answer: Delivered) => Promise<void>): Promise<void> {
		let error: string | undefined;
		try {
			await onAnswer(answer);
		} catch (thrown) {
			error = describe(thrown);
		}
		await store.lock(questionKey(answer.ref), async () => {
			const { question } = await load(answer.ref);
			if (question) await save(question, apply(question, { type: 'delivered', seq: answer.seq, ...(error !== undefined ? { error } : {}) }));
		});
	}

	/**
	 * One pass over every question. A question that fails does not stop the others; the errors
	 * come back. TokenRefused stops the pass at once.
	 */
	async function pass(restart: boolean): Promise<unknown[]> {
		const errors: unknown[] = [];
		const baseline = io.onAnswer ? await baselines(restart) : {};
		for (const key of await store.list('q:')) {
			try {
				const owed = await store.lock(key, () => repair(key.slice(2), baseline));
				if (owed && io.onAnswer) await deliver(owed, io.onAnswer);
			} catch (error) {
				if (error instanceof TokenRefused) throw error;
				errors.push(error);
			}
		}
		return errors;
	}

	// `flush` is serial per chat: a call during a pass requests one more pass and resolves with
	// it. A listener runs one chat, so this is serial per process for the listener.
	let running: Promise<void> | undefined;
	let again = false;
	let restartNext = false;
	function flush(options: { restart?: boolean } = {}): Promise<void> {
		again = true;
		if (options.restart) restartNext = true;
		running ??= (async () => {
			try {
				const errors: unknown[] = [];
				while (again) {
					again = false;
					const restart = restartNext;
					restartNext = false;
					errors.push(...(await pass(restart)));
				}
				if (errors.length > 0) throw errors[0];
			} finally {
				running = undefined;
			}
		})();
		return running;
	}

	/** The answer state of a question, polled until an answer, the deadline or a listener that is not alive. A ref the store does not hold takes no answer: it is closed. */
	async function wait(ref: string, options: { seconds?: number } = {}): Promise<Waited> {
		const seconds = options.seconds ?? WAIT_SECONDS.default;
		if (typeof seconds !== 'number' || Number.isNaN(seconds)) throw new ShapeError('seconds is not a number');
		const deadline = Date.now() + Math.min(Math.max(seconds, 0), WAIT_SECONDS.most) * 1000;
		for (;;) {
			const question = parseQuestion(await store.get(questionKey(ref)));
			const listener = listenerStatus(await store.get(LISTENER_KEY), now());
			if (!question || question.status === 'answered' || question.status === 'closed') {
				const answer = question && 'answer' in question ? question.answer : undefined;
				const by = question && 'by' in question ? question.by : undefined;
				return { status: question?.status === 'answered' ? 'answered' : 'closed', ...(answer ? { answer } : {}), ...(by ? { by } : {}), listener };
			}
			const left = deadline - Date.now();
			if (!listener.alive || left <= 0) return { status: 'pending', listener };
			await sleep(Math.min(WAIT_POLL, left));
		}
	}

	return {
		send,
		edit,
		close,
		handle,
		wait,
		flush,
		get: async (ref) => parseQuestion(await store.get(questionKey(ref))),
		updates: UPDATES,
	};
}
