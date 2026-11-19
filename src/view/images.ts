import { isRecord, isString } from '../core/check.ts';
import { SHELL_LIB } from './shell.ts';

export type ImageRef = { start: number; end: number; ref: string };

let parser: ((source: string) => unknown) | undefined;
function markdownBlocks(source: string): unknown {
	if (!parser) {
		const lib: unknown = new Function(`'use strict';\n${SHELL_LIB}\nreturn { markdownBlocks: markdownBlocks };`)();
		const parse = isRecord(lib) ? lib.markdownBlocks : undefined;
		if (typeof parse !== 'function') throw new Error('SHELL_LIB has no markdownBlocks');
		parser = (text) => Reflect.apply(parse, undefined, [text]);
	}
	return parser(source);
}

function imageSources(nodes: unknown): string[] {
	if (!Array.isArray(nodes)) return [];
	return nodes.flatMap((node: unknown) => {
		if (!isRecord(node)) return [];
		return [...(node.t === 'img' && isString(node.src) ? [node.src] : []), ...imageSources(node.c)];
	});
}

export function markdownImages(source: string): string[] {
	return [...new Set(imageSources(markdownBlocks(source)))];
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value: string): string {
	return value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
		if (name.startsWith('#')) {
			const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
			return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return NAMED[name.toLowerCase()] ?? whole;
	});
}

const TAG = /<[a-zA-Z][^\s/>]*(?:[^>"']|"[^"]*"|'[^']*')*>/y;
const NAME = /^<[a-zA-Z][^\s/>]*/;
const ATTRIBUTE = /[\s/]+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

export type Attribute = { name: string; value: string; start: number; end: number };

function tagAttributes(text: string, offset: number): Attribute[] {
	const found: Attribute[] = [];
	let at = NAME.exec(text)?.[0].length ?? 1;
	while (at < text.length - 1) {
		ATTRIBUTE.lastIndex = at;
		const match = ATTRIBUTE.exec(text);
		if (!match) {
			at++;
			continue;
		}
		at = ATTRIBUTE.lastIndex;
		const [, name = '', double, single, bare] = match;
		const raw = double ?? single ?? bare;
		if (raw === undefined) continue;
		const end = offset + at;
		found.push({ name: name.toLowerCase(), value: decodeEntities(raw), start: end - raw.length - (bare === undefined ? 2 : 0), end });
	}
	return found;
}

export function htmlAttributes(source: string): Attribute[] {
	const found: Attribute[] = [];
	let at = 0;
	while (at < source.length) {
		const open = source.indexOf('<', at);
		if (open === -1) break;
		if (source.startsWith('<!--', open)) {
			const close = source.indexOf('-->', open + 4);
			at = close === -1 ? source.length : close + 3;
			continue;
		}
		TAG.lastIndex = open;
		const tag = TAG.exec(source);
		if (!tag) {
			at = open + 1;
			continue;
		}
		found.push(...tagAttributes(tag[0], open));
		at = open + tag[0].length;
	}
	return found;
}
