import { describe, expect, test } from 'bun:test';
import { asked, input, NOW, sentFor, step, tap } from '../fixtures.ts';
import { choice, message, text } from './builders.ts';
import { mergeLabels } from './labels.ts';
import { parseQuestion } from './parse.ts';
import { reduce } from './reduce.ts';
import { render, renderEdit } from './render.ts';
import { type Body, defaultLabels, type Question, ShapeError } from './types.ts';

describe('mergeLabels', () => {
	test('merges over the English defaults', () => {
		expect(mergeLabels({ yes: 'Ja' })).toEqual({ ...defaultLabels, yes: 'Ja' });
		expect(mergeLabels()).toEqual(defaultLabels);
	});

	test('accepts 1 to 200 characters and refuses the rest', () => {
		expect(() => mergeLabels({ expired: 'x' })).not.toThrow();
		expect(() => mergeLabels({ expired: 'x'.repeat(200) })).not.toThrow();
		expect(() => mergeLabels({ expired: '' })).toThrow(ShapeError);
		expect(() => mergeLabels({ expired: 'x'.repeat(201) })).toThrow(ShapeError);
		expect(() => mergeLabels({ hintWords: ['tap', ''] })).toThrow(ShapeError);
		expect(() => mergeLabels({ hintWords: [] })).not.toThrow();
	});

	test('reduce, render and renderEdit refuse labels built by hand that break the rule', () => {
		const labels = { ...defaultLabels, expired: '' };
		const question = asked(text({ markdown: 'Proceed?' }), { expiresAt: NOW + 1 });
		expect(() => reduce(question, { type: 'delivered', seq: 0 }, { now: NOW + 1, labels })).toThrow(ShapeError);
		expect(() => render(message({ markdown: 'Hi' }), { chat: 111, labels })).toThrow(ShapeError);
		expect(() => renderEdit({ sent: { chat: 111, message: 1, files: [] }, body: { markdown: 'Hi' } }, labels)).toThrow(ShapeError);
	});
});

describe('a label placed into a body stays text', () => {
	const tricky = mergeLabels({ expired: '</details> ```fence `tick` *bold* [link](x) & <b>', question: '</summary><b>Q</b>' });
	const expire = (body: Body): Question => {
		const question = asked(choice(body, [{ label: 'A' }, { label: 'B' }]), { expiresAt: NOW + 10 });
		const open = step(question, { type: 'sent', sent: sentFor(question) });
		const next = reduce(open, { type: 'delivered', seq: 0 }, { now: NOW + 10, labels: tricky }).question;
		if (!next) throw new Error('no question');
		return next;
	};

	for (const body of [{ markdown: 'Proceed?' }, { html: 'Proceed?' }, { blocks: [{ type: 'paragraph' as const, text: 'Proceed?' }] }]) {
		test(`expiry of a ${Object.keys(body)[0]} question parses and renders`, () => {
			const closed = expire(body);
			expect(closed.status).toBe('closed');
			expect(parseQuestion(JSON.parse(JSON.stringify(closed)))).toEqual(closed);
			const edit = renderEdit(closed, tricky);
			const shown = edit.payload.rich_message as Body;
			// The edit body goes out as a message of its own without a refusal.
			expect(() => render(message(shown), { chat: 111 })).not.toThrow();
		});
	}

	test('Markdown and HTML escape the label, blocks carry it as plain text', () => {
		expect(expire({ markdown: 'Proceed?' })).toMatchObject({ resolved: { markdown: '&lt;/details&gt; \\`\\`\\`fence \\`tick\\` \\*bold\\* \\[link\\]\\(x\\) &amp; &lt;b&gt;' } });
		expect(expire({ html: 'Proceed?' })).toMatchObject({ resolved: { html: '&lt;/details&gt; ```fence `tick` *bold* [link](x) &amp; &lt;b&gt;' } });
		expect(expire({ blocks: [{ type: 'paragraph', text: 'Proceed?' }] })).toMatchObject({ resolved: { blocks: [{ type: 'paragraph', text: tricky.expired }] } });
		const markdown = renderEdit(expire({ markdown: 'Proceed?' }), tricky).payload.rich_message as { markdown: string };
		expect(markdown.markdown).toContain('<summary>&lt;/summary&gt;&lt;b&gt;Q&lt;/b&gt;</summary>');
	});

	test('a tap after such an expiry stays stale: closed', () => {
		const closed = expire({ markdown: 'Proceed?' });
		expect(reduce(closed, input(tap({ button: 0 })), { now: NOW + 20, labels: tricky }).handled).toEqual({ kind: 'stale', reason: 'closed' });
	});
});
