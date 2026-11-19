import type { Update } from '@grammyjs/types';
import { isNat, isRecord, isString, oneOf, optional } from '../core/check.ts';
import { isAnswer, isUser } from '../core/guards.ts';
import type { Handled, Store } from '../core/types.ts';
import { within } from '../chat/calls.ts';

export type UpdateHandled = Handled | { error: string };

export type InboundUpdate = { key: string; epoch: number; updateId: number; update: Update; handled: UpdateHandled };

export type StoredUpdate = InboundUpdate & { v: 1; attempts: number; error?: string; retryAt?: number };

export type Lane = 'tap' | 'other';

export const LANES = { tap: { slots: 4, deadline: 10_000 }, other: { slots: 1, deadline: 30_000 }, retry: { first: 30_000, most: 600_000 } };
export const UPDATE_ATTEMPTS = 5;

export const UPDATE_PREFIX = 'up:';

export function updateKey(update: Update, epoch: number): string {
	const raw: unknown = update;
	const message = isRecord(raw) ? raw.message : undefined;
	if (isRecord(message) && isNat(message.message_id) && isRecord(message.chat) && Number.isSafeInteger(message.chat.id)) return `${UPDATE_PREFIX}m:${String(message.chat.id)}:${message.message_id}`;
	const callback = isRecord(raw) ? raw.callback_query : undefined;
	if (isRecord(callback) && isString(callback.id) && callback.id !== '') return `${UPDATE_PREFIX}c:${callback.id}`;
	return `${UPDATE_PREFIX}u:${epoch}:${update.update_id}`;
}

export const laneOf = (key: string): Lane => (key.startsWith(`${UPDATE_PREFIX}c:`) ? 'tap' : 'other');

const isStale = oneOf('unknown', 'closed', 'forbidden', 'repeat');
function isUpdateHandled(value: unknown): value is UpdateHandled {
	if (!isRecord(value)) return false;
	if (value.kind === undefined) return isString(value.error);
	if (value.kind === 'ignored') return true;
	if (value.kind === 'stale') return isStale(value.reason);
	return value.kind === 'answered' && isString(value.ref) && isNat(value.seq) && isAnswer(value.answer) && isUser(value.by) && isNat(value.at) && optional(isAnswer)(value.previous);
}

export function parseStoredUpdate(value: unknown): StoredUpdate | undefined {
	if (!isRecord(value) || value.v !== 1 || !isString(value.key) || !isNat(value.epoch) || !isNat(value.updateId) || !isNat(value.attempts)) return undefined;
	if (!optional(isString)(value.error) || !optional(isNat)(value.retryAt) || !isUpdateHandled(value.handled)) return undefined;
	const update: unknown = value.update;
	if (!isRecord(update) || update.update_id !== value.updateId) return undefined;
	const { key, epoch, updateId, attempts, error, retryAt } = value;
	return {
		v: 1,
		key,
		epoch,
		updateId,
		update: { ...structuredClone(update), update_id: updateId },
		handled: structuredClone(value.handled),
		attempts,
		...(error !== undefined ? { error } : {}),
		...(retryAt !== undefined ? { retryAt } : {}),
	};
}

const payloadOf = ({ key, epoch, updateId, update, handled }: StoredUpdate): InboundUpdate => ({ key, epoch, updateId, update, handled });

export const retryDelay = (attempts: number) => Math.min(LANES.retry.first * 2 ** Math.max(0, attempts - 1), LANES.retry.most);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500) || 'no reason given';

type Delivery = { kind: 'delivered' } | { kind: 'failed'; error: string } | { kind: 'stopped' };

const byUpdate = (a: StoredUpdate, b: StoredUpdate) => a.epoch - b.epoch || a.updateId - b.updateId;

export function updateCourier(options: {
	store: Store;
	onUpdate: (update: InboundUpdate, deadline: number) => Promise<void>;
	log: (line: string) => void;
	now: () => number;
	track: (task: Promise<void>) => void;
	ended: Promise<undefined>;
	stopped: () => boolean;
}) {
	const { store, onUpdate, log, now, track, ended, stopped } = options;
	const queue = new Map<string, { receipt: StoredUpdate; due: number }>();
	const running = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function deliver(lane: Lane, receipt: StoredUpdate): Promise<void> {
		const { deadline } = LANES[lane];
		const outcome = await Promise.race([
			within(
				Promise.resolve()
					.then(() => onUpdate(payloadOf(receipt), deadline))
					.then(
						(): Delivery => ({ kind: 'delivered' }),
						(error: unknown): Delivery => ({ kind: 'failed', error: describe(error) }),
					),
				deadline,
				{ kind: 'failed', error: `the consumer did not finish within ${deadline / 1000} s` },
			),
			ended.then((): Delivery => ({ kind: 'stopped' })),
		]);
		if (outcome.kind === 'stopped' || stopped()) return;
		if (outcome.kind === 'delivered') {
			queue.delete(receipt.key);
			await store.delete(receipt.key).catch((error: unknown) => log(`receipt ${receipt.key} was delivered and stays in the store: ${describe(error)}`));
			return;
		}
		const attempts = receipt.attempts + 1;
		const retryAt = now() + retryDelay(attempts);
		const next: StoredUpdate = { ...receipt, attempts, error: outcome.error, retryAt };
		queue.set(receipt.key, { receipt: next, due: retryAt });
		await store.set(receipt.key, next).catch((error: unknown) => log(`the failure of receipt ${receipt.key} was not stored: ${describe(error)}`));
	}

	function pump(): void {
		clearTimeout(timer);
		timer = undefined;
		if (stopped()) return;
		const at = now();
		let next = Number.POSITIVE_INFINITY;
		const waiting = [...queue.values()].filter(({ receipt }) => !running.has(receipt.key)).sort((a, b) => byUpdate(a.receipt, b.receipt));
		for (const { receipt, due } of waiting) {
			if (due > at) {
				next = Math.min(next, due);
				continue;
			}
			const lane = laneOf(receipt.key);
			if ([...running].filter((key) => laneOf(key) === lane).length >= LANES[lane].slots) continue;
			running.add(receipt.key);
			track(
				deliver(lane, receipt).finally(() => {
					running.delete(receipt.key);
					pump();
				}),
			);
		}
		if (Number.isFinite(next)) timer = setTimeout(pump, Math.max(0, next - at));
	}

	return {
		async start(): Promise<void> {
			const loaded: StoredUpdate[] = [];
			for (const key of await store.list(UPDATE_PREFIX)) {
				const receipt = parseStoredUpdate(await store.get(key));
				if (receipt?.key === key) loaded.push(receipt);
				else log(`${key} breaks its type and stays in the store`);
			}
			for (const receipt of loaded) if (!queue.has(receipt.key)) queue.set(receipt.key, { receipt, due: now() });
			pump();
		},
		add(receipt: StoredUpdate): void {
			if (!queue.has(receipt.key)) queue.set(receipt.key, { receipt, due: now() });
			pump();
		},
		stop(): void {
			clearTimeout(timer);
			timer = undefined;
		},
	};
}
