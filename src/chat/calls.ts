// How `createChat` runs one Bot API call: with a deadline, with the one retry of a 429 that
// the outcome table of 4.5 allows, and with the message ids read from the server's answer.
import { isInt, isRecord } from '../core/check.ts';
import type { Call, CallResponse } from '../core/types.ts';

/** Deadlines in ms: every call, a files step without a video, and a files step with one. */
export const DEADLINES = { call: 30_000, photo: 30_000, video: 600_000 } as const;
/** A marked edit that cannot start within this many ms of its mark is not sent: its mark covers only this much delay. */
export const START_WINDOW = 30_000;
/** A 429 whose retry time lies at most this far ahead is retried once; a later one is given up. */
export const RETRY_WINDOW = 5_000;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** At most one send or edit per `interval` ms per chat id within one runtime. The tests of this package set it to 0. */
export const PACING = { interval: 1_000 };
// The calls that send or edit a message. A toast and a reaction pass the gate.
const PACED = new Set(['sendRichMessage', 'editMessageText', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendMediaGroup']);
// The gate of one chat id: when the transport took its last paced call on the monotonic clock,
// the calls that wait in arrival order, and whether a timer is set for the first of them. Shared
// by every chat of the runtime. A timer exists only while a call waits, so none keeps a process alive.
type Gate = { last: number; waiting: (() => void)[]; timer: boolean };
const gates = new Map<number, Gate>();

/** Starts the waiting calls of `gate` whose time has come, and sets one timer for the next. */
function drain(gate: Gate): void {
	while (!gate.timer && gate.waiting.length > 0) {
		// Measured again after every wake: a timer that fires early starts nothing.
		const wait = gate.last + PACING.interval - performance.now();
		if (wait > 0) {
			gate.timer = true;
			setTimeout(() => {
				gate.timer = false;
				drain(gate);
			}, wait);
			return;
		}
		gate.waiting.shift()?.();
	}
}

/**
 * Runs `invoke` under the gate of the call's chat: a send or an edit is handed to the transport
 * one interval after the previous one of that chat, in arrival order. The time is taken when
 * `invoke` returns, in the same synchronous step that admitted the call, so it lies after the
 * transport's synchronous part: work or a pause of the runtime there delays the next call instead
 * of shortening the interval. `invoke` must call the transport synchronously. A transport that
 * delays its request after it returns, such as a waiting grammY transformer, is not covered; a
 * 429 that follows is retried like any other.
 */
export function paced<T>(call: Call, invoke: () => Promise<T>): Promise<T> {
	const chat = call.payload.chat_id;
	if (!PACED.has(call.method) || typeof chat !== 'number' || PACING.interval <= 0) return invoke();
	let gate = gates.get(chat);
	if (!gate) {
		gate = { last: Number.NEGATIVE_INFINITY, waiting: [], timer: false };
		gates.set(chat, gate);
	}
	const own = gate;
	return new Promise<T>((resolve, reject) => {
		own.waiting.push(() => {
			const running = invoke();
			own.last = performance.now();
			running.then(resolve, reject);
		});
		drain(own);
	});
}

/**
 * `promise`, or `fallback` once `ms` have passed. The work behind `promise` goes on, and its
 * result is dropped: a call past its deadline counts as one without an answer.
 */
export async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	try {
		return await Promise.race([promise, expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** The deadline of a call: 600 s for a files step that holds a video, else 30 s. */
export function deadlineOf(call: Call): number {
	if (!call.files) return DEADLINES.call;
	const media = Array.isArray(call.payload.media) ? call.payload.media : [];
	const video = call.method === 'sendVideo' || media.some((item) => isRecord(item) && item.type === 'video');
	return video ? DEADLINES.video : DEADLINES.photo;
}

/** A files step with the body's message id as `reply_parameters.message_id`. */
export const replyingTo = (call: Call, message: number): Call => ({ ...call, payload: { ...call.payload, reply_parameters: { message_id: message } } });

const isMessage = (value: unknown): value is { message_id: number } => isRecord(value) && isInt(value.message_id) && value.message_id > 0;

/** The ids of the messages a send created: one for a message, one per file for an album. Undefined for any other answer. */
export function messageIds(result: unknown): number[] | undefined {
	const messages = Array.isArray(result) ? result : [result];
	return messages.length > 0 && messages.every(isMessage) ? messages.map((message) => message.message_id) : undefined;
}

/** A response that names no outcome: what a call past its deadline or a transport that threw reports. */
export const NO_ANSWER: CallResponse = { noAnswer: true };
