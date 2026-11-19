import { arrayOf, isInt, isRecord, isString, optional, sameJson } from '../core/check.ts';
import { classify } from '../core/classify.ts';
import { isBody, isSent } from '../core/guards.ts';
import { mergeLabels } from '../core/labels.ts';
import { parseQuestion } from '../core/parse.ts';
import { locate, RECHECK_DELAY, reduce } from '../core/reduce.ts';
import { bindingOf, inView, kindOf, render, renderEdit } from '../core/render.ts';
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
	type StoredChoice,
	TokenRefused,
	type Update,
	type User,
	type ViewClient,
	type Warning,
} from '../core/types.ts';
import { DEADLINES, deadlineOf, messageIds, NO_ANSWER, paced, RETRY_WINDOW, replyingTo, START_WINDOW, sleep, within } from './calls.ts';
import { DELIVERY_ATTEMPTS, LISTENER_KEY, listenerStatus, readRenewed, renew, spent } from './listener.ts';

export type Delivered = Extract<Handled, { kind: 'answered' }> & { delivery: string };

export type ChatIO = {
	call: (call: Call, files?: Record<string, Publishable>) => Promise<CallResponse>;
	store: Store;
	chat: number;
	allow?: number[];
	labels?: Partial<Labels>;
	now?: () => number;
	viewOrigin?: string;
	views?: ViewClient;
	files?: (paths: string[]) => Promise<Readable>;
	fileLimit?: number;
	guards?: ((spec: Spec) => string | undefined)[];
	onAnswer?: (answer: Delivered) => Promise<void>;
};

export type SendOptions = { ref?: string; topic?: number; meta?: Json; expiresAt?: number; strict?: boolean; dryRun?: boolean; needsListener?: boolean };
export type Waited = { status: 'pending' | 'answered' | 'closed'; answer?: Answer; by?: User; listener: { alive: boolean; stopped?: string } };

export type Chat = {
	send(spec: Spec, options?: SendOptions): Promise<Outcome>;
	edit(sent: Sent, body: Body): Promise<Outcome>;
	close(ref: string, body?: Body): Promise<Outcome>;
	handle(update: Update): Promise<Handled>;
	choose(choice: StoredChoice): Promise<Handled>;
	wait(ref: string, options?: { seconds?: number }): Promise<Waited>;
	flush(options?: { restart?: boolean }): Promise<void>;
	get(ref: string): Promise<Question | undefined>;
	updates: readonly ['message', 'callback_query'];
};

type Refused = Extract<Outcome, { kind: 'refused' }>;

export { DELIVERY_ATTEMPTS };
export const deliveryKey = (question: Pick<Question, 'ref' | 'seq'>) => `${question.ref}:${question.seq}`;
export const WAIT_SECONDS = { default: 10, most: 50 } as const;
const WAIT_POLL = 200;
const LIMITS = { photo: 10_000_000, file: 50_000_000 } as const;
const UPDATES = ['message', 'callback_query'] as const;
const OK: CallClass = { kind: 'ok', result: null };
const REF_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export const questionKey = (ref: string) => `q:${ref}`;
export const tombstoneKey = (ref: string) => `t:${ref}`;
export const indexKey = (at: { chat: number; message: number }) => `m:${at.chat}:${at.message}`;

const refused = (code: Refused['code'], reason: string): Refused => ({ kind: 'refused', code, reason });
const sentOf = (question: Question): Sent | undefined => ('sent' in question ? question.sent : undefined);
const statusOf = (question: Question) => (question.status === 'answered' || question.status === 'closed' ? question.status : 'pending');
const isQuestionSpec = (spec: Spec): spec is Question['spec'] => spec.answer !== undefined;
function sameRef(ref: string, value: unknown): Question | undefined {
	const question = parseQuestion(value);
	return question?.ref === ref ? question : undefined;
}
function withRecheck(question: Question, recheckAt: number | undefined): Question {
	const { recheckAt: _recheckAt, ...shown } = question.shown;
	return { ...question, shown: recheckAt === undefined ? shown : { ...shown, recheckAt } };
}
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500) || 'no reason given';

function shapeRefusal(error: unknown): Refused {
	if (error instanceof ShapeError) return refused('shape', error.message);
	throw error;
}

function newRef(): string {
	return [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => REF_ALPHABET.charAt(byte % 32)).join('');
}

async function closeAll(files: Publishable[]): Promise<void> {
	await Promise.allSettled([...new Set(files)].map((file) => file.close()));
}

function failure(result: CallClass): { class: 'refused' | 'uncertain'; reason: string } {
	if (result.kind === 'refused') return { class: 'refused', reason: result.reason };
	if (result.kind === 'retry') return { class: 'refused', reason: `the server asked to wait longer than ${RETRY_WINDOW / 1000} s` };
	if (result.kind === 'unchanged') return { class: 'refused', reason: 'the server answered as if to an edit' };
	return { class: 'uncertain', reason: 'the files step got no answer' };
}

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

	const apply = (question: Question, event: QuestionEvent): Question => reduce(question, event, { now: now(), labels }).question ?? question;

	const questionOf = async (ref: string) => sameRef(ref, await store.get(questionKey(ref)));

	async function load(ref: string): Promise<{ question: Question | undefined; held: boolean }> {
		const value = await store.get(questionKey(ref));
		return { question: sameRef(ref, value), held: value !== undefined };
	}

	async function save(previous: Question | undefined, next: Question): Promise<Question> {
		if (previous && sameJson(previous, next)) return next;
		const read = parseQuestion(JSON.parse(JSON.stringify(next)));
		if (!read || !sameJson(read, next)) throw new Error(`question ${next.ref} would not read back from the store`);
		await store.set(questionKey(next.ref), next);
		return next;
	}

	async function bury(ref: string): Promise<void> {
		await store.set(tombstoneKey(ref), { v: 1, at: now() });
		await store.delete(questionKey(ref));
	}

	async function index(question: Question): Promise<void> {
		const sent = sentOf(question);
		if (sent && (await store.get(indexKey(sent))) !== question.ref) await store.set(indexKey(sent), question.ref);
	}

	async function rebuildIndex(): Promise<void> {
		for (const key of await store.list('q:')) {
			const question = parseQuestion(await store.get(key));
			if (question) await index(question);
		}
	}

	async function indexed(at: { chat: number; message: number }): Promise<string | undefined> {
		const entry = await store.get(indexKey(at));
		if (isString(entry)) return entry;
		await rebuildIndex();
		const rebuilt = await store.get(indexKey(at));
		return isString(rebuilt) ? rebuilt : undefined;
	}

	function invoke(call: Call, files?: Record<string, Publishable>): Promise<CallResponse> {
		try {
			return io.call(call, files).catch(() => NO_ANSWER);
		} catch {
			return Promise.resolve(NO_ANSWER);
		}
	}

	async function request(call: Call, files?: Record<string, Publishable>): Promise<CallClass> {
		const response = await paced(call, () => within(invoke(call, files), deadlineOf(call), NO_ANSWER));
		return classify(call.method, response);
	}

	async function requestMarked(call: Call, startBy: number): Promise<{ result: CallClass; start: number } | undefined> {
		let start = 0;
		const response = await paced(call, () => {
			start = now();
			return start > startBy ? Promise.resolve(undefined) : within(invoke(call), deadlineOf(call), NO_ANSWER);
		});
		return response && { result: classify(call.method, response), start };
	}

	function unlessToken(result: CallClass): CallClass {
		if (result.kind === 'refused' && result.code === 'token') throw new TokenRefused(`the server refused the bot token: ${result.reason}`);
		return result;
	}

	async function requestRetrying(call: Call, files?: Record<string, Publishable>): Promise<CallClass> {
		const first = await request(call, files);
		if (first.kind !== 'retry') return first;
		const wait = (first.at ?? now()) - now();
		if (wait > RETRY_WINDOW) return first;
		await sleep(Math.max(0, wait));
		return request(call, files);
	}

	async function tabRefusal(spec: Spec): Promise<Refused | undefined> {
		const { views } = io;
		const view = spec.view;
		const tabs = spec.answer?.type === 'choice' ? spec.answer.options.flatMap((option) => (option.tab !== undefined ? [option.tab] : [])) : [];
		if (view === undefined || !views || tabs.length === 0) return undefined;
		const found = await hosted(() => views.has(view));
		if (!found) return refused('server', `the view host gave no answer about the view ${view}`);
		if (found.kind === 'refused') return refused('server', `the view host refused to read the view ${view}: ${found.reason}`);
		if (found.kind === 'missing') return refused('shape', `the view ${view} is not on the view host`);
		const lacking = tabs.find((tab) => !found.tabs.includes(tab));
		return lacking === undefined ? undefined : refused('shape', `the view ${view} has no tab "${lacking}", its tabs are ${found.tabs.map((tab) => `"${tab}"`).join(', ')}`);
	}

	function hosted<T>(request: () => Promise<T>): Promise<T | undefined> {
		return within(
			Promise.resolve()
				.then(request)
				.catch(() => undefined),
			DEADLINES.call,
			undefined,
		);
	}

	async function bindView(asked: Question): Promise<Question | Refused> {
		const { views } = io;
		const view = asked.spec.view;
		if (!views || view === undefined) return refused('view-host', 'a question answered in its view needs the client of a view host, and createChat was given none');
		const version = await hosted(() => views.version());
		if (!version) return refused('view-host', 'the view host gave no answer about its formats');
		if (version.kind === 'refused') return refused('view-host', `the view host refused to name its formats: ${version.reason}`);
		if (!version.formats.includes('answers')) return refused('view-host', 'the view host takes no answers in a view: a person runs telegram-agent-ui view deploy');
		const found = await hosted(() => views.has(view));
		if (!found) return refused('view-host', `the view host gave no answer about the view ${view}`);
		if (found.kind === 'refused') return refused('view-host', `the view host refused to read the view ${view}: ${found.reason}`);
		if (found.kind === 'missing') return refused('view-host', `the view ${view} is not on the view host`);
		const binding = bindingOf(asked);
		const lacking = binding?.options.find((option) => !found.tabs.includes(option.tab));
		if (lacking) return refused('view-host', `the view ${view} has no tab "${lacking.tab}", its tabs are ${found.tabs.map((tab) => `"${tab}"`).join(', ')}`);
		const expiresAt = Math.min(asked.expiresAt ?? found.expiresAt, found.expiresAt);
		const question: Question = { ...asked, expiresAt };
		const stored = await writeContext(question);
		if (stored.kind !== 'ok') return refused('view-host', `the view host did not store the question with its options${stored.kind === 'refused' ? `: ${stored.reason}` : ''}`);
		return question;
	}

	async function writeContext(question: Question): Promise<CallClass> {
		const { views } = io;
		const view = question.spec.view;
		if (view === undefined || !views) return OK;
		if (question.viewOrigin !== io.viewOrigin) {
			return { kind: 'refused', code: 'server', reason: `the view button opens ${question.viewOrigin ?? 'no origin'}, and the view client writes to ${io.viewOrigin ?? 'no origin'}: the context there stays as it was` };
		}
		const binding = bindingOf(question);
		const answer = await hosted(() => (binding ? views.context(view, question.ref, question.spec.body, binding) : views.context(view, question.ref, question.spec.body)));
		if (!answer) return { kind: 'uncertain' };
		if (answer.kind === 'ok') return OK;
		return { kind: 'refused', code: 'server', reason: answer.kind === 'missing' ? `the view ${view} is missing on the view host` : answer.reason };
	}

	async function show(question: Question, recheck = false): Promise<Question> {
		const sent = sentOf(question);
		const { want, done, retryAt, recheckAt: before } = question.shown;
		const due = want > done || (recheck && before !== undefined && before <= now());
		if (!sent || !due || (retryAt !== undefined && retryAt > now())) return question;
		let call: Call;
		try {
			call = renderEdit(question, labels);
		} catch (error) {
			return save(question, owing(apply(question, { type: 'shown', want, outcome: { kind: 'refused', code: 'server', reason: shapeRefusal(error).reason } })));
		}
		const startBy = now() + START_WINDOW;
		const mark = startBy + deadlineOf(call) + RECHECK_DELAY;
		const marked = await save(question, withRecheck(question, mark));
		const started = await requestMarked(call, startBy);
		if (!started) {
			return save(marked, withRecheck(apply(marked, { type: 'shown', want, outcome: { kind: 'uncertain' } }), before));
		}
		let outcome = unlessToken(started.result);
		let wrote = false;
		if (outcome.kind === 'ok' || outcome.kind === 'unchanged') {
			outcome = await writeContext(marked);
			wrote = outcome.kind === 'ok';
		}
		let next = wrote ? settled(apply(marked, { type: 'shown', want, outcome })) : owing(apply(marked, { type: 'shown', want, outcome }));
		if (outcome.kind === 'uncertain') {
			const windowEnd = started.start + deadlineOf(call) + RECHECK_DELAY;
			next = withRecheck(next, Math.max(next.shown.recheckAt ?? 0, windowEnd));
		} else if (next.shown.recheckAt === mark) next = withRecheck(next, before);
		return save(marked, next);
	}

	function owing(question: Question): Question {
		return question.status === 'closed' && bindingOf(question) !== undefined ? { ...question, bindingOwed: true } : question;
	}

	function settled(question: Question): Question {
		const next = { ...question };
		delete next.bindingOwed;
		return next;
	}

	async function settle(question: Question): Promise<Question> {
		if (!question.bindingOwed) return question;
		const { views } = io;
		const view = question.spec.view;
		const binding = bindingOf(question);
		const over = () => question.expiresAt !== undefined && now() >= question.expiresAt;
		if (!views || view === undefined || !binding || question.viewOrigin !== io.viewOrigin || over()) return save(question, settled(question));
		const answer = await hosted(() => views.context(view, question.ref, question.spec.body, binding));
		return answer?.kind === 'ok' || over() ? save(question, settled(question)) : question;
	}

	function stateWarnings(question: Question): Warning[] {
		const warnings: Warning[] = [];
		if (!sentOf(question)) {
			const way = !inView(question.spec.answer)
				? 'the first tap on its buttons reveals it'
				: question.status === 'closed'
					? 'it has no answer button, so ask again with a new ref'
					: 'it has no answer button, so close it and ask again';
			warnings.push({ code: 'unconfirmed-message', message: `no message of question ${question.ref} is known: ${way}` });
		}
		if (question.shown.error !== undefined) warnings.push({ code: 'not-shown', message: `the message does not show the state of question ${question.ref}: ${question.shown.error}` });
		return warnings;
	}

	function stated(question: Question, warnings: Warning[] = []): Outcome {
		const sent = sentOf(question);
		return { kind: 'ok', ...(sent ? { sent } : {}), ref: question.ref, status: statusOf(question), warnings: [...warnings, ...stateWarnings(question)] };
	}

	function held(question: Question, steps: Step[], warnings: Warning[]): Outcome {
		const sent = sentOf(question);
		let covered = sent?.files.length ?? 0;
		for (const [index, step] of steps.entries()) {
			if (step.role !== 'files' || !sent) continue;
			const count = step.call.files?.length ?? 0;
			if (covered < count) {
				const reason = `message ${sent.message} holds ${sent.files.length} of ${(question.spec.attach ?? []).length} files: files step ${index} was refused, lost its answer or still runs, and a retry sends no file again`;
				return { kind: 'partial', sent, ref: question.ref, failed: { step: index, class: 'uncertain', reason }, warnings: [...warnings, ...stateWarnings(question)] };
			}
			covered -= count;
		}
		return stated(question, warnings);
	}

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

	function unsent(result: Exclude<CallClass, { kind: 'ok' | 'uncertain' }>): Refused {
		if (result.kind === 'refused') return refused(result.code, result.reason);
		if (result.kind === 'retry') return refused('busy', `the server asked to wait longer than ${RETRY_WINDOW / 1000} s`);
		return refused('server', 'the server answered the send as if it were an edit');
	}

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

	async function ask(asked: Question, steps: Step[], warnings: Warning[], needsListener: boolean): Promise<Outcome> {
		const { ref } = asked;
		const [body] = steps;
		if (!body) throw new Error('render returned no body step');
		const owned: Publishable[] = [];
		try {
			const first = await store.lock(questionKey(ref), async (): Promise<Outcome | { kind: 'sent'; sent: Sent; shown: Question; files: Map<string, Publishable> }> => {
				if ((await store.get(tombstoneKey(ref))) !== undefined) return refused('ref-conflict', `the ref ${ref} belonged to a question that is gone`);
				const { question: stored, held: taken } = await load(ref);
				if (taken) return stored && sameJson(stored.spec, asked.spec) ? held(stored, steps, warnings) : refused('ref-conflict', `the ref ${ref} belongs to another question`);
				if (asked.status === 'closed') return refused('closed', 'expiresAt has passed');
				if (needsListener && !listenerStatus(await store.get(LISTENER_KEY), now()).alive) return refused('no-listener', 'no listener is alive to receive the answer');
				const viewOnly = inView(asked.spec.answer);
				const lacking = viewOnly ? undefined : await tabRefusal(asked.spec);
				if (lacking) return lacking;
				const opened = await open(asked.spec, owned);
				if (opened.kind === 'refused') return opened;
				const bound = viewOnly ? await bindView(asked) : asked;
				if ('kind' in bound) return bound;
				let question = await save(undefined, bound);
				if (!viewOnly && (await writeContext(question)).kind !== 'ok') {
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
							: viewOnly
								? 'the body got no answer: a question answered in its view without a known message takes no answer, close it and ask again'
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
		if (dryRun) {
			const owned: Publishable[] = [];
			try {
				const opened = await open(spec, owned);
				return opened.kind === 'refused' ? opened : { kind: 'dry', steps, warnings };
			} finally {
				await closeAll(owned);
			}
		}
		return asked ? ask(asked, steps, warnings, needsListener === true) : post(spec, steps, warnings, topic);
	}

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
			return stated(await settle(await show(await save(question, next))));
		});
	}

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
			for (const call of result.calls) unlessToken(await request(call));
			if (current) await show(current);
			return result.handled ?? { kind: 'ignored' };
		});
	}

	async function choose(choice: StoredChoice): Promise<Handled> {
		if (!isRecord(choice) || !isString(choice.ref) || !REF.test(choice.ref) || !isString(choice.view)) throw new ShapeError('the stored choice breaks its type');
		const { ref, view, id, user, index, at } = choice;
		return store.lock(questionKey(ref), async () => {
			const { question } = await load(ref);
			if (question && question.spec.view !== view) return { kind: 'stale', reason: 'unknown' };
			const result = reduce(question, { type: 'choice', id, user, index, at }, { now: now(), labels });
			const current = result.question ? await save(question, result.question) : undefined;
			if (current) await show(current);
			return result.handled ?? { kind: 'ignored' };
		});
	}

	function delivered(question: Question): Delivered | undefined {
		if (question.status !== 'answered' && question.status !== 'closed') return undefined;
		const { ref, seq, answer, by, answeredAt, previous, meta } = question;
		if (!answer || !by || answeredAt === undefined) return undefined;
		return { kind: 'answered', ref, seq, answer, by, at: answeredAt, ...(previous ? { previous } : {}), ...(meta !== undefined ? { meta } : {}), delivery: deliveryKey(question) };
	}

	async function baselines(restart: boolean): Promise<Record<string, number>> {
		if (!restart) return (await readRenewed(store)).answers;
		const owed: { key: string; attempts: number }[] = [];
		for (const key of await store.list('q:')) {
			const question = parseQuestion(await store.get(key));
			if (question && question.delivery.seq < question.seq) owed.push({ key: deliveryKey(question), attempts: question.delivery.attempts });
		}
		return (await renew(store, 'answers', owed)).answers;
	}

	async function repair(ref: string, baseline: Record<string, number>): Promise<Delivered | undefined> {
		if ((await store.get(tombstoneKey(ref))) !== undefined) {
			await store.delete(questionKey(ref));
			return undefined;
		}
		const loaded = (await load(ref)).question;
		if (!loaded) return undefined;
		let question = loaded;
		if (question.expiresAt !== undefined && question.status !== 'closed' && now() >= question.expiresAt) {
			question = await save(question, apply(question, { type: 'delivered', seq: question.delivery.seq }));
		}
		await index(question);
		question = await settle(await show(question, true));
		const owed = question.delivery.seq < question.seq && !spent(question.delivery.attempts, baseline[deliveryKey(question)]);
		return io.onAnswer && owed ? delivered(question) : undefined;
	}

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

	async function wait(ref: string, options: { seconds?: number } = {}): Promise<Waited> {
		const seconds = options.seconds ?? WAIT_SECONDS.default;
		if (typeof seconds !== 'number' || Number.isNaN(seconds)) throw new ShapeError('seconds is not a number');
		const deadline = Date.now() + Math.min(Math.max(seconds, 0), WAIT_SECONDS.most) * 1000;
		for (;;) {
			const question = await questionOf(ref);
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
		choose,
		wait,
		flush,
		get: questionOf,
		updates: UPDATES,
	};
}
