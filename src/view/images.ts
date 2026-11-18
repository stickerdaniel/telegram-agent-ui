// Where a view's Markdown and pages name images, for `prepareView`.
//
// Markdown is read by the shell's own parser, `markdownBlocks` of SHELL_LIB, the one the phone
// draws with: an image is an image here exactly when the shell draws it as one, so code in a
// quote, a list or a table stays code. Its source is never rewritten: the stored tab maps each
// destination, as this parser reads it, to its media index, and the shell looks it up there.
//
// HTML is read in one lexical pass: comments, tags and their quoted or bare attribute values, so
// `<!--` inside a quoted value opens no comment. Character references in values are decoded. A
// page draws in a sandboxed frame the shell cannot reach into, so its values are rewritten: each
// attribute comes with the source range of its value.
import { isRecord, isString } from '../core/check.ts';
import { SHELL_LIB } from './shell.ts';

/** One image reference of a page: the source range of its value to replace, and the address it names. */
export type ImageRef = { start: number; end: number; ref: string };

/**
 * The shell's Markdown parser, evaluated once from the text the shell page serves. The function
 * body is the package's own constant SHELL_LIB; the Markdown reaches the parser as an argument.
 */
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

/** The `src` of every image node of a shell tree, depth first. */
function imageSources(nodes: unknown): string[] {
	if (!Array.isArray(nodes)) return [];
	return nodes.flatMap((node: unknown) => {
		if (!isRecord(node)) return [];
		return [...(node.t === 'img' && isString(node.src) ? [node.src] : []), ...imageSources(node.c)];
	});
}

/** The destination of every image of a Markdown source as the shell draws it, in order, each once. */
export function markdownImages(source: string): string[] {
	return [...new Set(imageSources(markdownBlocks(source)))];
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** An attribute value with its character references decoded; a reference it does not know stays. */
export function decodeEntities(value: string): string {
	return value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
		if (name.startsWith('#')) {
			const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
			return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return NAMED[name.toLowerCase()] ?? whole;
	});
}

// A start tag at the scan position, with quoted values that may hold `>` or `<!--`.
const TAG = /<[a-zA-Z][^\s/>]*(?:[^>"']|"[^"]*"|'[^']*')*>/y;
const NAME = /^<[a-zA-Z][^\s/>]*/;
// One attribute after the tag name: its name, and a double-quoted, single-quoted or bare value.
const ATTRIBUTE = /[\s/]+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

/** One attribute of a page's tag: its name in lower case, its decoded value and the source range of the value, quotes included. */
export type Attribute = { name: string; value: string; start: number; end: number };

/** The attributes with a value of the tag `text`, which starts at `offset` of the source. */
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

/**
 * Every attribute that has a value, of every start tag of an HTML source outside comments. One
 * pass from the start: a comment runs from `<!--` to `-->` or the end, a tag to the `>` outside
 * its quoted values, and any other character is text.
 */
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
