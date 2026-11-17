// The `listener` key of a store. Only the holder of the listener lease writes it, see 5.2 of
// the plan: a heartbeat every 30 s, and the reason once it stops. `createChat` reads it for
// `needsListener` and `wait`.
import { isNat, isRecord, isString, optional } from '../core/check.ts';

/** The value of the `listener` key. `heartbeat` is the time of the last beat, `stopped` the reason once the listener ended. */
export type ListenerRecord = { v: 1; heartbeat: number; stopped?: string };

export const LISTENER_KEY = 'listener';
/** A listener is alive while its heartbeat is younger than this. */
export const HEARTBEAT_AGE = 90_000;

const isListenerRecord = (value: unknown): value is ListenerRecord => isRecord(value) && value.v === 1 && isNat(value.heartbeat) && optional(isString)(value.stopped);

/** Whether a listener is alive at `now`, from the stored value of the `listener` key. A missing or unreadable value is no listener. */
export function listenerStatus(value: unknown, now: number): { alive: boolean; stopped?: string } {
	if (!isListenerRecord(value)) return { alive: false };
	if (value.stopped !== undefined) return { alive: false, stopped: value.stopped };
	return { alive: now - value.heartbeat < HEARTBEAT_AGE };
}
