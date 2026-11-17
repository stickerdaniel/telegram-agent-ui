// The `listener` key of a store, see 5.2 of the plan. The holder of the listener lease writes a
// heartbeat every 30 s, the time of the last poll that Telegram answered, the meta keys of its
// answer command, and the reason once it stops. The delivery worker, `createChat` for answers and
// the listener's courier for messages, stores in it the baselines of its renewed budgets, which
// it and `info` both count from. `createChat` reads the record for `needsListener` and `wait`,
// and the `ask` command for `next`.
import { arrayOf, isNat, isRecord, isString, optional } from '../core/check.ts';
import type { Store } from '../core/types.ts';

/** Delivery attempts by key at the last renewal: from there each key has 5 attempts more. */
export type Renewed = { answers: Record<string, number>; messages: Record<string, number> };

/**
 * The value of the `listener` key. `heartbeat` is the time of the last beat, `polled` the time
 * the last getUpdates answered, `push` present while an answer command receives every answer,
 * with the meta keys it declared, `renewed` the baselines of the renewed budgets, by the
 * delivery key `<ref>:<seq>` of an answer and the key `in:<chat>:<message id>` of a message, and
 * `stopped` the reason once the listener ended.
 */
export type ListenerRecord = { v: 1; heartbeat: number; polled?: number; push?: { metaKeys: string[] }; renewed?: Renewed; stopped?: string };

export const LISTENER_KEY = 'listener';
/** A listener is alive while its heartbeat is younger than this. */
export const HEARTBEAT_AGE = 90_000;

const isPush = (value: unknown): value is { metaKeys: string[] } => isRecord(value) && arrayOf(isString)(value.metaKeys);
const isCounts = (value: unknown): value is Record<string, number> => isRecord(value) && Object.values(value).every(isNat);
const isRenewed = (value: unknown): value is Renewed => isRecord(value) && isCounts(value.answers) && isCounts(value.messages);

/** The stored value of the `listener` key, or undefined when it breaks its type. */
export function parseListener(value: unknown): ListenerRecord | undefined {
	if (!isRecord(value) || value.v !== 1 || !isNat(value.heartbeat) || !optional(isNat)(value.polled) || !optional(isPush)(value.push) || !optional(isString)(value.stopped)) return undefined;
	if (!optional(isRenewed)(value.renewed)) return undefined;
	const { heartbeat, polled, push, renewed, stopped } = value;
	return {
		v: 1,
		heartbeat,
		...(polled !== undefined ? { polled } : {}),
		...(push !== undefined ? { push: { metaKeys: [...push.metaKeys] } } : {}),
		...(renewed !== undefined ? { renewed: { answers: { ...renewed.answers }, messages: { ...renewed.messages } } } : {}),
		...(stopped !== undefined ? { stopped } : {}),
	};
}

/** Whether a listener is alive at `now`, from the stored value of the `listener` key. A missing or unreadable value is no listener. */
export function listenerStatus(value: unknown, now: number): { alive: boolean; stopped?: string } {
	const record = parseListener(value);
	if (!record) return { alive: false };
	if (record.stopped !== undefined) return { alive: false, stopped: record.stopped };
	return { alive: now - record.heartbeat < HEARTBEAT_AGE };
}

/** After this many rejected deliveries an answer or a message counts as undelivered until a restart pass renews it. */
export const DELIVERY_ATTEMPTS = 5;

/** Attempts that count against the budget of 5: those since the last renewal. */
export const attemptsSince = (attempts: number, renewed: number | undefined) => attempts - (renewed ?? 0);

/** True when a delivery with `attempts` so far and the stored `renewed` baseline has spent its budget. */
export const spent = (attempts: number, renewed: number | undefined) => attemptsSince(attempts, renewed) >= DELIVERY_ATTEMPTS;

// The lock under which the baselines and the rest of the listener record change, so that no
// write of one replaces a newer write of the other.
const RECORD_LOCK = 'listener-record';
const emptyRenewed = (): Renewed => ({ answers: {}, messages: {} });

/** The baselines every delivery worker and `info` count from, as the listener record holds them. */
export async function readRenewed(store: Store): Promise<Renewed> {
	return parseListener(await store.get(LISTENER_KEY))?.renewed ?? emptyRenewed();
}

/**
 * A restart's renewal of one kind: every owed delivery whose budget since its baseline is spent
 * gets its attempts as its new baseline, one that is not keeps its baseline, and a key that is
 * owed no more is dropped. Stored in the listener record, which keeps its other fields; a store
 * without a record gets one with heartbeat 0, which is no live listener. Returns the baselines.
 */
export function renew(store: Store, kind: keyof Renewed, owed: { key: string; attempts: number }[]): Promise<Renewed> {
	return store.lock(RECORD_LOCK, async () => {
		const record = parseListener(await store.get(LISTENER_KEY));
		const current = record?.renewed ?? emptyRenewed();
		const next: Record<string, number> = {};
		for (const { key, attempts } of owed) {
			const base = current[kind][key];
			if (spent(attempts, base)) next[key] = attempts;
			else if (base !== undefined) next[key] = base;
		}
		const renewed = { ...current, [kind]: next };
		await store.set(LISTENER_KEY, { ...(record ?? { v: 1, heartbeat: 0 }), renewed });
		return renewed;
	});
}

/** Writes the listener record from `fields`, keeping the baselines it holds. */
export function writeListener(store: Store, fields: Omit<ListenerRecord, 'v' | 'renewed'>): Promise<void> {
	return store.lock(RECORD_LOCK, async () => {
		const renewed = parseListener(await store.get(LISTENER_KEY))?.renewed;
		await store.set(LISTENER_KEY, { v: 1, ...fields, ...(renewed ? { renewed } : {}) });
	});
}
