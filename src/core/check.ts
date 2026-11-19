import type { Json } from './types.ts';

export type Check<T> = (value: unknown) => value is T;

export function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
export const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
export const isNat = (value: unknown): value is number => isInt(value) && value >= 0;
export const isString = (value: unknown): value is string => typeof value === 'string';
export const isBool = (value: unknown): value is boolean => typeof value === 'boolean';
export const optional =
	<T>(check: Check<T>) =>
	(value: unknown): value is T | undefined =>
		value === undefined || check(value);
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

export const JSON_LEVELS = 64;

const INDEX = /^(0|[1-9]\d*)$/;
const plainArray = (array: unknown[]) => Object.getPrototypeOf(array) === Array.prototype && Reflect.ownKeys(array).every((key) => key === 'length' || (typeof key === 'string' && INDEX.test(key) && Number(key) < array.length));

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

export function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
	if (!isRecord(a) || !isRecord(b)) return false;
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameJson(a[key], b[key]));
}

export const isJson = (value: unknown): value is Json => storable(value);
