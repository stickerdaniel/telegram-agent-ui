// Primitive runtime predicates, shared by the rich block checks and the stored-type guards.
import type { Json } from './types.ts';

export type Check<T> = (value: unknown) => value is T;

/** A plain object, as JSON holds one: no array, no Date, no class instance. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
export const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
/** A non-negative integer: every counter and time of a question. */
export const isNat = (value: unknown): value is number => isInt(value) && value >= 0;
export const isString = (value: unknown): value is string => typeof value === 'string';
export const isBool = (value: unknown): value is boolean => typeof value === 'boolean';
export const optional =
	<T>(check: Check<T>) =>
	(value: unknown): value is T | undefined =>
		value === undefined || check(value);
/** Every index of an array passes `check`; a hole fails, since JSON would turn it into null. */
function everyIndex(array: unknown[], check: (item: unknown) => boolean): boolean {
	for (let index = 0; index < array.length; index++) if (!(index in array) || !check(array[index])) return false;
	return true;
}
export const arrayOf =
	<T>(check: Check<T>) =>
	(value: unknown): value is T[] =>
		Array.isArray(value) && everyIndex(value, check);
export const oneOf =
	<const T extends string | number>(...values: T[]) =>
	(value: unknown): value is T =>
		values.some((option) => option === value);

/** How many levels of objects and arrays a stored question may nest: a body or a meta of 48 levels sits 2 levels down. */
export const JSON_LEVELS = 64;

const INDEX = /^(0|[1-9]\d*)$/;
/** An array JSON writes as its elements: a plain `Array`, so no inherited `toJSON`, and no own property beside its indices and `length`. */
const plainArray = (array: unknown[]) => Object.getPrototypeOf(array) === Array.prototype && Reflect.ownKeys(array).every((key) => key === 'length' || (typeof key === 'string' && INDEX.test(key) && Number(key) < array.length));

/**
 * A value that JSON stores and reads back unchanged: null, a boolean, a string, a finite
 * number, or a dense array or plain object of such values, with at most `levels` objects and
 * arrays on any path (64 by default). A cycle, an undefined value, a BigInt, a function, a
 * class instance, an array with a property of its own or an object with its own `toJSON`
 * fails. One object referenced twice without a cycle passes, since JSON writes it twice.
 */
export function storable(value: unknown, levels = JSON_LEVELS): boolean {
	const ancestors = new Set<object>();
	const walk = (node: unknown, level: number): boolean => {
		if (node === null || typeof node === 'boolean' || typeof node === 'string') return true;
		if (typeof node === 'number') return Number.isFinite(node);
		if (typeof node !== 'object' || level > levels || ancestors.has(node)) return false;
		if (Array.isArray(node) ? !plainArray(node) : !isRecord(node) || typeof node.toJSON === 'function') return false;
		ancestors.add(node);
		const fits = Array.isArray(node) ? everyIndex(node, (item) => walk(item, level + 1)) : Object.values(node).every((item) => walk(item, level + 1));
		ancestors.delete(node);
		return fits;
	};
	return walk(value, 1);
}

/** `storable` as a type guard, for fields typed as Json. */
export const isJson = (value: unknown): value is Json => storable(value);
