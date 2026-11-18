// Updates for `onUpdate`, see 5.2: every admitted update is stored as a receipt under a key of
// its own before the listener's cursor moves, and a courier hands each receipt to the consumer
// in one of two lanes. A message's key is its chat and message id, a tap's its callback query
// id; an edit and a reaction have no identity of their own below the second, so their key is
// the listener's epoch and the update id. A replay before the cursor moves therefore gets the
// same key, and a consumer that deduplicates by key sees each update once in effect.
//
// The tap lane runs up to 4 deliveries at once, each with a 10 s deadline, since Telegram
// expects a tap to be answered within seconds. The other lane runs one delivery at a time with a
// 30 s deadline, in the numeric order of epoch and update id. A delivery that fails waits for its
// retry, 30 s doubling to at most 10 minutes, and holds back no receipt after it: a consumer sees
// gaps and late arrivals and orders by update id itself. A receipt is retried as long as the
// listener runs, and a listener's start makes every stored receipt due at once.
import type { Update } from '@grammyjs/types';
import { isNat, isRecord, isString, oneOf, optional } from '../core/check.ts';
import { isAnswer, isUser } from '../core/guards.ts';
import type { Handled, Store } from '../core/types.ts';
import { within } from '../chat/calls.ts';

/** What `handle` did with an update, or why it refused the update's shape. */
export type UpdateHandled = Handled | { error: string };

/** What `onUpdate` receives: the update as Telegram sent it, under its key, with the epoch of its update id and what `handle` did with it. */
export type InboundUpdate = { key: string; epoch: number; updateId: number; update: Update; handled: UpdateHandled };

/** The stored value of a receipt: the update, its delivery attempts so far, and the last error with the time of the next retry. */
export type StoredUpdate = InboundUpdate & { v: 1; attempts: number; error?: string; retryAt?: number };

/** The two lanes of delivery: taps, and everything else. */
export type Lane = 'tap' | 'other';

/**
 * The lanes in ms and slots: how many deliveries run at once and each one's deadline, and the
 * retry of a failed delivery, from `first` doubling to at most `most`. The tests of this package
 * shorten them.
 */
export const LANES = { tap: { slots: 4, deadline: 10_000 }, other: { slots: 1, deadline: 30_000 }, retry: { first: 30_000, most: 600_000 } };
/** After this many failed deliveries `info` lists a receipt as undelivered; it is still retried. */
export const UPDATE_ATTEMPTS = 5;

export const UPDATE_PREFIX = 'up:';

/**
 * The key of an update: `up:m:<chat>:<message id>` for a message, `up:c:<callback query id>` for
 * a tap, and `up:u:<epoch>:<update id>` for an edit, a reaction, and any update whose own
 * identity breaks its type.
 */
export function updateKey(update: Update, epoch: number): string {
	const raw: unknown = update;
	const message = isRecord(raw) ? raw.message : undefined;
	if (isRecord(message) && isNat(message.message_id) && isRecord(message.chat) && Number.isSafeInteger(message.chat.id)) return `${UPDATE_PREFIX}m:${String(message.chat.id)}:${message.message_id}`;
	const callback = isRecord(raw) ? raw.callback_query : undefined;
	if (isRecord(callback) && isString(callback.id) && callback.id !== '') return `${UPDATE_PREFIX}c:${callback.id}`;
	return `${UPDATE_PREFIX}u:${epoch}:${update.update_id}`;
}

/** The lane of a receipt, by its key. */
export const laneOf = (key: string): Lane => (key.startsWith(`${UPDATE_PREFIX}c:`) ? 'tap' : 'other');

const isStale = oneOf('unknown', 'closed', 'forbidden', 'repeat');
/** A Handled as `handle` returns it, or an error with its reason. */
function isUpdateHandled(value: unknown): value is UpdateHandled {
	if (!isRecord(value)) return false;
	if (value.kind === undefined) return isString(value.error);
	if (value.kind === 'ignored') return true;
	if (value.kind === 'stale') return isStale(value.reason);
	return value.kind === 'answered' && isString(value.ref) && isNat(value.seq) && isAnswer(value.answer) && isUser(value.by) && isNat(value.at) && optional(isAnswer)(value.previous);
}

/** A stored receipt, or undefined when any field breaks its type. */
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

/** What the consumer gets of a stored receipt. */
const payloadOf = ({ key, epoch, updateId, update, handled }: StoredUpdate): InboundUpdate => ({ key, epoch, updateId, update, handled });

/** The wait before the retry after `attempts` failed deliveries: `first` doubling, at most `most`. */
export const retryDelay = (attempts: number) => Math.min(LANES.retry.first * 2 ** Math.max(0, attempts - 1), LANES.retry.most);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500) || 'no reason given';

/** How one delivery ended: the consumer took the receipt, failed, or the listener stopped first. */
type Delivery = { kind: 'delivered' } | { kind: 'failed'; error: string } | { kind: 'stopped' };

/** Orders receipts by epoch, then by update id, as numbers. */
const byUpdate = (a: StoredUpdate, b: StoredUpdate) => a.epoch - b.epoch || a.updateId - b.updateId;

/**
 * The courier of `onUpdate`. `start` loads every stored receipt and makes each due; `add` takes
 * a receipt the listener has just stored. Each delivery calls `onUpdate` with the receipt and
 * the lane's deadline, and counts as failed when it rejects or passes that deadline. A delivered
 * receipt is deleted; a failed one stores its attempts, error and next retry. Each delivery runs
 * through `track`, so the listener drains it before it gives up its lease; once `stopped` holds,
 * no delivery starts, and one that is still running writes nothing, so its receipt stays for the
 * next start. Only the holder of the listener lease runs one.
 */
export function updateCourier(options: {
	store: Store;
	onUpdate: (update: InboundUpdate, deadline: number) => Promise<void>;
	log: (line: string) => void;
	now: () => number;
	track: (task: Promise<void>) => void;
	/** Resolves once the listener stops. */
	ended: Promise<undefined>;
	stopped: () => boolean;
}) {
	const { store, onUpdate, log, now, track, ended, stopped } = options;
	// Every receipt not yet delivered, with the time from which it may run.
	const queue = new Map<string, { receipt: StoredUpdate; due: number }>();
	const running = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Delivers one receipt, then stores its result. The consumer's answer is tagged, so no reason
	 * it rejects with, whatever its text, reads as the listener's own stop.
	 */
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

	/** Starts every due receipt a lane has a free slot for, in order, and sets one timer for the next due one. */
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
		/**
		 * Loads every stored receipt and makes each due now. Rejects when the store fails a read;
		 * nothing of that scan joins the lanes then, so the caller runs it again whole, and a
		 * receipt already queued keeps its place.
		 */
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
		/** A receipt the listener stored: it is due at once. */
		add(receipt: StoredUpdate): void {
			if (!queue.has(receipt.key)) queue.set(receipt.key, { receipt, due: now() });
			pump();
		},
		/** Clears the timer; the listener's drain waits for the deliveries that run. */
		stop(): void {
			clearTimeout(timer);
			timer = undefined;
		},
	};
}
