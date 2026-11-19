import { arrayOf, isNat, isRecord, isString, optional } from '../core/check.ts';
import type { Store } from '../core/types.ts';

export type Renewed = { answers: Record<string, number>; messages: Record<string, number> };

export type ListenerRecord = { v: 1; heartbeat: number; polled?: number; push?: { metaKeys: string[] }; renewed?: Renewed; stopped?: string };

export const LISTENER_KEY = 'listener';
export const HEARTBEAT_AGE = 90_000;

const isPush = (value: unknown): value is { metaKeys: string[] } => isRecord(value) && arrayOf(isString)(value.metaKeys);
const isCounts = (value: unknown): value is Record<string, number> => isRecord(value) && Object.values(value).every(isNat);
const isRenewed = (value: unknown): value is Renewed => isRecord(value) && isCounts(value.answers) && isCounts(value.messages);

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

export function listenerStatus(value: unknown, now: number): { alive: boolean; stopped?: string } {
	const record = parseListener(value);
	if (!record) return { alive: false };
	if (record.stopped !== undefined) return { alive: false, stopped: record.stopped };
	return { alive: now - record.heartbeat < HEARTBEAT_AGE };
}

export const DELIVERY_ATTEMPTS = 5;

export const attemptsSince = (attempts: number, renewed: number | undefined) => attempts - (renewed ?? 0);

export const spent = (attempts: number, renewed: number | undefined) => attemptsSince(attempts, renewed) >= DELIVERY_ATTEMPTS;

const RECORD_LOCK = 'listener-record';
const emptyRenewed = (): Renewed => ({ answers: {}, messages: {} });

export async function readRenewed(store: Store): Promise<Renewed> {
	return parseListener(await store.get(LISTENER_KEY))?.renewed ?? emptyRenewed();
}

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

export function writeListener(store: Store, fields: Omit<ListenerRecord, 'v' | 'renewed'>): Promise<void> {
	return store.lock(RECORD_LOCK, async () => {
		const renewed = parseListener(await store.get(LISTENER_KEY))?.renewed;
		await store.set(LISTENER_KEY, { v: 1, ...fields, ...(renewed ? { renewed } : {}) });
	});
}
