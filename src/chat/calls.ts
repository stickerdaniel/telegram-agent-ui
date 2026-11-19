import { isInt, isRecord } from '../core/check.ts';
import type { Call, CallResponse } from '../core/types.ts';

export const DEADLINES = { call: 30_000, photo: 30_000, video: 600_000 };
export const START_WINDOW = 30_000;
export const RETRY_WINDOW = 5_000;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const PACING = { interval: 1_000 };
const PACED = new Set(['sendRichMessage', 'editMessageText', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendMediaGroup']);
type Gate = { last: number; waiting: (() => void)[]; timer: boolean };
const gates = new Map<number, Gate>();

function drain(gate: Gate): void {
	while (!gate.timer && gate.waiting.length > 0) {
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

export function deadlineOf(call: Call): number {
	if (!call.files) return DEADLINES.call;
	const media = Array.isArray(call.payload.media) ? call.payload.media : [];
	const video = call.method === 'sendVideo' || media.some((item) => isRecord(item) && item.type === 'video');
	return video ? DEADLINES.video : DEADLINES.photo;
}

export const replyingTo = (call: Call, message: number): Call => ({ ...call, payload: { ...call.payload, reply_parameters: { message_id: message } } });

const isMessage = (value: unknown): value is { message_id: number } => isRecord(value) && isInt(value.message_id) && value.message_id > 0;

export function messageIds(result: unknown): number[] | undefined {
	const messages = Array.isArray(result) ? result : [result];
	return messages.length > 0 && messages.every(isMessage) ? messages.map((message) => message.message_id) : undefined;
}

export const NO_ANSWER: CallResponse = { noAnswer: true };
