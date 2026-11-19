import { describe, expect, test } from 'bun:test';
import type { RichText } from '@grammyjs/types';
import { asked, CHAT, NOW, ORIGIN, REF, sentFor, states, step, USER } from '../fixtures.ts';
import { choice, message, text } from './builders.ts';
import { mergeLabels } from './labels.ts';
import { parseQuestion } from './parse.ts';
import { reduce } from './reduce.ts';
import { render, renderEdit } from './render.ts';
import { type Body, defaultLabels, type Json, type Question, type QuestionEvent, ShapeError } from './types.ts';

type Ask = Extract<QuestionEvent, { type: 'ask' }>;
const ask = (extra: Partial<Ask> = {}): Ask => ({ type: 'ask', spec: text({ markdown: 'Proceed?' }), ref: 'r', chat: CHAT, allow: [USER], ...extra });
const roundTrip = (question: Question | undefined) => {
	const json: unknown = JSON.parse(JSON.stringify(question));
	expect(json).toStrictEqual(question);
	expect(parseQuestion(json)).toStrictEqual(question);
};

describe('labels', () => {
	test('a label of white space only is refused, and an expiry with accepted labels parses', () => {
		for (const blank of [' ', '\n', '\t  ']) {
			expect(() => mergeLabels({ expired: blank })).toThrow(ShapeError);
			expect(() => mergeLabels({ hintWords: ['tap', blank] })).toThrow(ShapeError);
			expect(() => reduce(asked(text({ markdown: 'Proceed?' }), { expiresAt: NOW }), { type: 'delivered', seq: 0 }, { now: NOW, labels: { ...defaultLabels, expired: blank } })).toThrow(ShapeError);
		}
		const labels = mergeLabels({ expired: ' x ' });
		const closed = reduce(asked(text({ markdown: 'Proceed?' }), { expiresAt: NOW + 1 }), { type: 'delivered', seq: 0 }, { now: NOW + 1, labels }).question;
		expect(closed).toMatchObject({ status: 'closed', resolved: { markdown: ' x ' } });
		roundTrip(closed);
	});

	test('the defaults cannot be changed, and mergeLabels returns a word list of its own', () => {
		expect(Object.isFrozen(defaultLabels)).toBe(true);
		expect(Object.isFrozen(defaultLabels.hintWords)).toBe(true);
		expect(() => {
			(defaultLabels as { expired: string }).expired = '';
		}).toThrow(TypeError);
		const merged = mergeLabels();
		expect(merged.hintWords).not.toBe(defaultLabels.hintWords);
		(merged.hintWords as string[]).push('press here');
		expect(defaultLabels.hintWords).not.toContain('press here');
	});
});

describe('buttons inside a body', () => {
	const foreignView: Body = { blocks: [{ type: 'buttons', buttons: [{ text: 'Open', web_app: { url: 'https://attacker.example' } }] }] };
	const foreignCallback: Body = { blocks: [{ type: 'paragraph', text: ['Pick ', { type: 'button', button: { text: 'Other', callback_data: 'q:other:1' } }, '?'] }] };
	const nested: Body = { blocks: [{ type: 'details', summary: 'More', blocks: [{ type: 'table', cells: [[{ text: { type: 'button', button: { text: 'Copy', copy_text: { text: 'x' } } }, align: 'left', valign: 'top' }]] }] }] };

	const recordedMarkdown: Body[] = [
		{ markdown: 'F: <tg-button type="callback_data" data="q:other:1">x</tg-button> end' },
		{ markdown: 'G: [btn](tg://btn) and <tg-button type="url" url="https://t.me">u</tg-button>' },
	];
	const tags: Body[] = [
		{ html: 'Pick <tg-button type="web_app" url="https://attacker.example">Open</tg-button>' },
		{ html: '<tg-button-row align="left"><tg-button type="copy_text" text="x">Copy</tg-button></tg-button-row>' },
		{ markdown: 'Run `<TG-BUTTON type="url" url="https://t.me">u</TG-BUTTON>`' },
	];

	test('render, renderEdit, reduce and parseQuestion refuse a buttons block, an inline button and a button tag at any depth', () => {
		const open = states(text({ blocks: [{ type: 'paragraph', text: 'Why?' }] })).open;
		for (const body of [foreignView, foreignCallback, nested]) {
			expect(() => render(message(body), { chat: CHAT, viewOrigin: ORIGIN })).toThrow(ShapeError);
			expect(() => render(choice(body, [{ label: 'A' }, { label: 'B' }]), { chat: CHAT, ref: 'own' })).toThrow(ShapeError);
			expect(() => renderEdit({ sent: { chat: CHAT, message: 1, files: [] }, body })).toThrow(ShapeError);
			expect(() => reduce(open, { type: 'edit', body }, { now: NOW })).toThrow(ShapeError);
			expect(() => reduce(open, { type: 'close', body }, { now: NOW })).toThrow(ShapeError);
			expect(() => reduce(undefined, ask({ spec: text(body) }), { now: NOW })).toThrow(ShapeError);
			expect(parseQuestion({ ...structuredClone(open), spec: { ...open.spec, body } })).toBeUndefined();
		}
		for (const body of [...recordedMarkdown, ...tags]) {
			const textOpen = states(text('html' in body ? { html: 'Why?' } : { markdown: 'Why?' })).open;
			expect(() => render(message(body), { chat: CHAT }), JSON.stringify(body)).toThrow(new ShapeError('a body may hold no button of its own: buttons come from answer and view'));
			expect(() => renderEdit({ sent: { chat: CHAT, message: 1, files: [] }, body })).toThrow(ShapeError);
			expect(() => reduce(textOpen, { type: 'edit', body }, { now: NOW })).toThrow(ShapeError);
			expect(() => reduce(textOpen, { type: 'close', body }, { now: NOW })).toThrow(ShapeError);
			expect(() => reduce(undefined, ask({ spec: text(body) }), { now: NOW })).toThrow(ShapeError);
			expect(parseQuestion({ ...structuredClone(textOpen), spec: { ...textOpen.spec, body } })).toBeUndefined();
		}
		expect(() => render(message({ markdown: 'G: [btn](tg://btn) and the tg-button docs' }), { chat: CHAT })).not.toThrow();
	});
});

describe('values JSON cannot store', () => {
	test('holes in arrays are refused', () => {
		const sparse = new Array<number>(1);
		expect(() => reduce(undefined, ask({ allow: sparse }), { now: NOW })).toThrow(ShapeError);
		const blocks: Extract<Body, { blocks: unknown }>['blocks'] = new Array(1);
		expect(() => reduce(undefined, ask({ spec: text({ blocks }) }), { now: NOW })).toThrow(ShapeError);
		expect(() => render(message({ blocks }), { chat: CHAT })).toThrow(ShapeError);
		const question = asked(text({ markdown: 'Proceed?' }));
		expect(parseQuestion({ ...structuredClone(question), allow: sparse })).toBeUndefined();
	});

	test('a BigInt, a function or undefined anywhere is refused', () => {
		const block = { type: 'paragraph' as const, text: 'Go?', extra: 1n };
		expect(() => reduce(undefined, ask({ spec: text({ blocks: [block] }) }), { now: NOW })).toThrow(ShapeError);
		expect(() => render(message({ blocks: [block] }), { chat: CHAT })).toThrow(ShapeError);
		const withFunction = { type: 'paragraph' as const, text: 'Go?', extra: () => 1 };
		expect(() => reduce(undefined, ask({ spec: text({ blocks: [withFunction] }) }), { now: NOW })).toThrow(ShapeError);
		expect(parseQuestion({ ...structuredClone(asked(text({ markdown: 'Go?' }))), meta: { at: undefined } })).toBeUndefined();
	});

	test('a cycle is refused with ShapeError or undefined, and a shared reference passes', () => {
		const cyclic: Record<string, Json> = { a: 1 };
		cyclic.self = cyclic;
		expect(() => reduce(undefined, ask({ meta: cyclic }), { now: NOW })).toThrow(ShapeError);
		const rich: unknown[] = ['Why'];
		rich.push(rich);
		const cyclicBody = { blocks: [{ type: 'paragraph', text: rich }] } as unknown as Body;
		expect(() => reduce(undefined, ask({ spec: text(cyclicBody) }), { now: NOW })).toThrow(ShapeError);
		expect(() => render(message(cyclicBody), { chat: CHAT })).toThrow(ShapeError);
		const question = asked(text({ markdown: 'Go?' }));
		expect(parseQuestion({ ...structuredClone(question), meta: cyclic })).toBeUndefined();
		expect(parseQuestion({ ...structuredClone(question), spec: { ...question.spec, body: cyclicBody } })).toBeUndefined();
		const shared: Json = { id: 7 };
		const ok = reduce(undefined, ask({ meta: { first: shared, second: shared } }), { now: NOW }).question;
		expect(ok?.meta).toEqual({ first: { id: 7 }, second: { id: 7 } });
		roundTrip(ok);
	});

	test('nesting deeper than 64 levels is refused without running out of stack', () => {
		let deep: Json = 'x';
		for (let n = 0; n < 100_000; n++) deep = [deep];
		expect(() => reduce(undefined, ask({ meta: deep }), { now: NOW })).toThrow(ShapeError);
		expect(parseQuestion({ ...structuredClone(asked(text({ markdown: 'Go?' }))), meta: deep })).toBeUndefined();
	});
});

describe('refs', () => {
	test('a ref that is not a string is refused', () => {
		const event: unknown = JSON.parse(JSON.stringify(ask({ ref: 'r' })).replace('"ref":"r"', '"ref":123'));
		expect(() => reduce(undefined, event as QuestionEvent, { now: NOW })).toThrow(ShapeError);
		expect(() => render(text({ markdown: 'Go?' }), { chat: CHAT, ref: 123 as unknown as string })).toThrow(ShapeError);
	});
});

describe('rich blocks', () => {
	const open = states(text({ blocks: [{ type: 'paragraph', text: 'Why?' }] })).open;
	const withBody = (body: unknown) => ({ ...structuredClone(open), spec: { ...open.spec, body } });

	test('an inherited key names no rich text node', () => {
		for (const type of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
			expect(parseQuestion(withBody({ blocks: [{ type: 'paragraph', text: { type, text: 'x', '[object Object]': 'y' } }] }))).toBeUndefined();
		}
	});

	test('a media block holds the InputMedia of its own variant', () => {
		const photo = { type: 'photo', media: 'file_id', caption: 'A photo', has_spoiler: true };
		expect(parseQuestion(withBody({ blocks: [{ type: 'photo', photo }] }))).toBeDefined();
		expect(parseQuestion(withBody({ blocks: [{ type: 'photo', photo: { type: 'video', media: 'file_id' } }] }))).toBeUndefined();
		expect(parseQuestion(withBody({ blocks: [{ type: 'photo', photo: { ...photo, has_spoiler: 'yes' } }] }))).toBeUndefined();
		expect(parseQuestion(withBody({ blocks: [{ type: 'photo', photo: { ...photo, thumbnail: 'attach://t' } }] }))).toBeUndefined();
		expect(parseQuestion(withBody({ blocks: [{ type: 'video', video: { type: 'video', media: 'file_id', duration: 1.5 } }] }))).toBeUndefined();
		expect(parseQuestion(withBody({ blocks: [{ type: 'voice_note', voice_note: { type: 'voice_note', media: 'file_id', duration: 7 } }] }))).toBeDefined();
	});
});

test('the fixtures used here survive a JSON round trip', () => {
	for (const question of Object.values(states(choice({ markdown: 'Which?' }, [{ label: 'A' }, { label: 'B' }])))) roundTrip(question);
	roundTrip(step(asked(text({ markdown: 'Why?' })), { type: 'sent', sent: { ...sentFor(asked(text({ markdown: 'Why?' }))), ref: REF } }));
});

describe('nesting of a body and a meta', () => {
	const bodyOf = (levels: number): Body => {
		let rich: RichText = 'Go?';
		for (let n = 0; n < levels - 3; n++) rich = { type: 'bold', text: rich };
		return { blocks: [{ type: 'paragraph', text: rich }] };
	};
	const metaOf = (levels: number): Json => {
		let meta: Json = 'x';
		for (let n = 0; n < levels; n++) meta = [meta];
		return meta;
	};
	const sentOpen = (body: Body) => {
		const question = asked(text(body));
		return step(question, { type: 'sent', sent: sentFor(question) });
	};

	test('a body of 48 levels passes ask, edit and close, and every returned question parses before and after JSON', () => {
		const at48 = bodyOf(48);
		expect(storableLevels(at48)).toBe(48);
		const fromAsk = sentOpen(at48);
		roundTrip(fromAsk);
		const edited = reduce(sentOpen({ blocks: [{ type: 'paragraph', text: 'Old?' }] }), { type: 'edit', body: at48 }, { now: NOW }).question;
		roundTrip(edited);
		const closed = reduce(sentOpen({ blocks: [{ type: 'paragraph', text: 'Old?' }] }), { type: 'close', body: at48 }, { now: NOW }).question;
		roundTrip(closed);
		const resolved = step(fromAsk, { type: 'close', body: { blocks: [{ type: 'paragraph', text: 'Done' }] } });
		const shown = renderEdit(resolved).payload.rich_message as Body;
		expect(shown).toEqual({ blocks: [{ type: 'paragraph', text: 'Done' }] });
		expect(() => render(message(shown), { chat: CHAT })).not.toThrow();
		expect(() => render(message(at48), { chat: CHAT })).not.toThrow();
	});

	test('a body of 49 levels is refused before any state is returned', () => {
		const at49 = bodyOf(49);
		expect(storableLevels(at49)).toBe(49);
		const open = sentOpen({ blocks: [{ type: 'paragraph', text: 'Old?' }] });
		expect(() => reduce(undefined, ask({ spec: text(at49) }), { now: NOW })).toThrow(ShapeError);
		expect(() => reduce(open, { type: 'edit', body: at49 }, { now: NOW })).toThrow(ShapeError);
		expect(() => reduce(open, { type: 'close', body: at49 }, { now: NOW })).toThrow(ShapeError);
		expect(() => render(message(at49), { chat: CHAT })).toThrow(ShapeError);
		expect(() => renderEdit({ sent: { chat: CHAT, message: 1, files: [] }, body: at49 })).toThrow(ShapeError);
		expect(parseQuestion({ ...structuredClone(open), spec: { ...open.spec, body: at49 } })).toBeUndefined();
		expect(() => reduce(open, { type: 'edit', body: bodyOf(64) }, { now: NOW })).toThrow(ShapeError);
	});

	test('a meta of 48 levels passes and 49 is refused', () => {
		roundTrip(reduce(undefined, ask({ meta: metaOf(48) }), { now: NOW }).question);
		expect(() => reduce(undefined, ask({ meta: metaOf(49) }), { now: NOW })).toThrow(ShapeError);
		expect(parseQuestion({ ...structuredClone(asked(text({ markdown: 'Go?' }))), meta: metaOf(49) })).toBeUndefined();
	});
});

describe('serialization hooks', () => {
	test('an array of a subclass or with a property of its own and an object with its own toJSON are refused, a plain array passes', () => {
		const changed = Object.assign([1, 2], { toJSON: () => ({ role: 'changed' }) });
		const throwing = Object.assign([], { toJSON: () => 1n });
		const extra = Object.assign([1], { note: 'x' });
		const object = { a: 1, toJSON: () => 'other' };
		class Changed extends Array<number> {
			toJSON() {
				return { role: 'changed' };
			}
		}
		class Throws extends Array<number> {
			toJSON() {
				return 1n;
			}
		}
		for (const meta of [changed, throwing, extra, object, Changed.from([1, 2]), Throws.from([1])]) {
			expect(() => reduce(undefined, ask({ meta: meta as unknown as Json }), { now: NOW })).toThrow(ShapeError);
			expect(parseQuestion({ ...structuredClone(asked(text({ markdown: 'Go?' }))), meta })).toBeUndefined();
		}
		roundTrip(reduce(undefined, ask({ meta: [1, 2] }), { now: NOW }).question);
	});
});

describe('caption entities', () => {
	const open = states(text({ blocks: [{ type: 'paragraph', text: 'Why?' }] })).open;
	const photoWith = (entity: unknown): Body => ({ blocks: [{ type: 'photo', photo: { type: 'photo', media: 'file_id', caption: 'x y', caption_entities: [entity] } }] }) as Body;
	const user = { id: 111, is_bot: false, first_name: 'x' };

	test('each variant of MessageEntity passes with its fields', () => {
		const valid = [
			{ type: 'bold', offset: 0, length: 1 },
			{ type: 'expandable_blockquote', offset: 0, length: 3 },
			{ type: 'pre', offset: 0, length: 1 },
			{ type: 'pre', offset: 0, length: 1, language: 'ts' },
			{ type: 'text_link', offset: 0, length: 1, url: 'https://example.com' },
			{ type: 'text_mention', offset: 0, length: 1, user },
			{ type: 'custom_emoji', offset: 0, length: 1, custom_emoji_id: '5368324170671202286' },
			{ type: 'date_time', offset: 0, length: 1, unix_time: 1794908513, date_time_format: 'wDT' },
		];
		for (const entity of valid) {
			expect(parseQuestion({ ...structuredClone(open), spec: { ...open.spec, body: photoWith(entity) } }), entity.type).toBeDefined();
			expect(() => reduce(undefined, ask({ spec: text(photoWith(entity)) }), { now: NOW })).not.toThrow();
		}
	});

	test('an unknown type, a missing field or a field of the wrong type is refused', () => {
		const invalid = [
			{ type: 'not-an-entity', offset: 0, length: 1 },
			{ type: 'text_link', offset: 0, length: 1 },
			{ type: 'text_link', offset: 0, length: 1, url: 123 },
			{ type: 'text_mention', offset: 0, length: 1 },
			{ type: 'text_mention', offset: 0, length: 1, user: { id: 111, first_name: 'x' } },
			{ type: 'custom_emoji', offset: 0, length: 1 },
			{ type: 'date_time', offset: 0, length: 1, unix_time: 1794908513, date_time_format: 'x' },
			{ type: 'pre', offset: 0, length: 1, language: 5 },
			{ type: 'bold', offset: -1, length: 1 },
			{ type: 'bold', offset: 0 },
		];
		for (const entity of invalid) {
			expect(parseQuestion({ ...structuredClone(open), spec: { ...open.spec, body: photoWith(entity) } }), JSON.stringify(entity)).toBeUndefined();
			expect(() => reduce(undefined, ask({ spec: text(photoWith(entity)) }), { now: NOW })).toThrow(ShapeError);
		}
	});
});

describe('hint words', () => {
	test('a word list with a hole is refused before warnings run, a full or empty one passes', () => {
		const spec = text({ markdown: 'Proceed?' });
		expect(() => render(spec, { chat: CHAT, ref: 'r', labels: { ...defaultLabels, hintWords: new Array<string>(1) } })).toThrow(ShapeError);
		expect(() => render(spec, { chat: CHAT, ref: 'r', labels: { ...defaultLabels, hintWords: ['tap'] } })).not.toThrow();
		expect(() => render(spec, { chat: CHAT, ref: 'r', labels: { ...defaultLabels, hintWords: [] } })).not.toThrow();
	});
});

function storableLevels(value: unknown): number {
	return Array.isArray(value) ? 1 + Math.max(0, ...value.map(storableLevels)) : value !== null && typeof value === 'object' ? 1 + Math.max(0, ...Object.values(value).map(storableLevels)) : 0;
}
