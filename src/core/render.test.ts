import { describe, expect, test } from 'bun:test';
import { asked, CHAT, NOW, ORIGIN, REF, sentFor, step, VIEW } from '../fixtures.ts';
import { choice, message, text, yesNo } from './builders.ts';
import { render, renderEdit } from './render.ts';
import { type Attachment, type Body, defaultLabels, ShapeError, type Spec } from './types.ts';

const at = { chat: CHAT, ref: REF };

describe('render', () => {
	test('a choice is one sendRichMessage with one button per row, styles kept', () => {
		const { steps } = render(choice({ markdown: 'Which way?' }, [{ label: 'Rebase', style: 'primary' }, { label: 'Merge' }]), at);
		expect(steps).toEqual([
			{
				role: 'body',
				call: {
					method: 'sendRichMessage',
					payload: {
						chat_id: CHAT,
						rich_message: { markdown: 'Which way?' },
						reply_markup: { inline_keyboard: [[{ text: 'Rebase', callback_data: `q:${REF}:0`, style: 'primary' }], [{ text: 'Merge', callback_data: `q:${REF}:1` }]] },
					},
				},
			},
		]);
	});

	test('yesNo puts both buttons in one row, and topic and silent reach every step', () => {
		const { steps } = render(yesNo({ markdown: 'Ship it?' }, { silent: true, attach: [{ path: '/tmp/a.png' }] }), { ...at, topic: 7 });
		expect(steps[0]?.call.payload).toMatchObject({ message_thread_id: 7, disable_notification: true, reply_markup: { inline_keyboard: [[{ text: 'Yes' }, { text: 'No' }]] } });
		expect(steps[1]?.call.payload).toMatchObject({ chat_id: CHAT, message_thread_id: 7, disable_notification: true });
	});

	test('a view adds a Web App row built from the given origin, with the ref of a question', () => {
		const plain = render(message({ markdown: 'Diff ready.' }, { view: VIEW }), { chat: CHAT, viewOrigin: ORIGIN });
		expect(plain.steps[0]?.call.payload.reply_markup).toEqual({ inline_keyboard: [[{ text: defaultLabels.view, web_app: { url: `${ORIGIN}/?v=${VIEW}` } }]] });
		const asked = render(text({ markdown: 'What next?' }, { view: VIEW }), { ...at, viewOrigin: ORIGIN });
		expect(asked.steps[0]?.call.payload.reply_markup).toEqual({ inline_keyboard: [[{ text: defaultLabels.view, web_app: { url: `${ORIGIN}/?v=${VIEW}&q=${REF}` } }]] });
	});

	test('a message without buttons has no reply_markup', () => {
		expect(render(message({ markdown: 'Build passed.' }), { chat: CHAT }).steps[0]?.call.payload).toEqual({ chat_id: CHAT, rich_message: { markdown: 'Build passed.' } });
	});

	describe('files steps', () => {
		const files: Attachment[] = [
			{ path: '/p/a.png', caption: 'first' },
			{ path: '/p/notes.pdf' },
			{ path: '/p/b.jpg' },
			{ path: '/p/clip.mp4' },
			{ path: '/p/log.txt' },
		];
		const { steps } = render(message({ markdown: 'Results.' }, { attach: files }), { chat: CHAT });

		test('every files step is a template with role files and no reply_parameters', () => {
			expect(steps.map((step) => step.role)).toEqual(['body', 'files', 'files']);
			for (const step of steps) expect(step.call.payload).not.toHaveProperty('reply_parameters');
		});

		test('photos and videos form one album, documents another', () => {
			expect(steps[1]?.call).toEqual({
				method: 'sendMediaGroup',
				payload: {
					chat_id: CHAT,
					media: [
						{ type: 'photo', media: 'attach://file0', caption: 'first' },
						{ type: 'photo', media: 'attach://file1' },
						{ type: 'video', media: 'attach://file2', supports_streaming: true },
					],
				},
				files: [
					{ field: 'file0', path: '/p/a.png' },
					{ field: 'file1', path: '/p/b.jpg' },
					{ field: 'file2', path: '/p/clip.mp4' },
				],
			});
			expect(steps[2]?.call).toMatchObject({ method: 'sendMediaGroup', payload: { media: [{ type: 'document' }, { type: 'document' }] } });
		});

		test('a single file goes out as its own method, and `as` overrides the ending', () => {
			const one = render(message({ markdown: 'Log.' }, { attach: [{ path: '/p/shot.png', as: 'document', caption: 'raw' }] }), { chat: CHAT });
			expect(one.steps[1]).toEqual({ role: 'files', call: { method: 'sendDocument', payload: { chat_id: CHAT, caption: 'raw' }, files: [{ field: 'document', path: '/p/shot.png' }] } });
			const video = render(message({ markdown: 'Clip.' }, { attach: [{ path: '/p/clip.mp4' }] }), { chat: CHAT });
			expect(video.steps[1]?.call).toMatchObject({ method: 'sendVideo', payload: { supports_streaming: true }, files: [{ field: 'video' }] });
		});
	});
});

describe('the shape checks of section 8', () => {
	const options = [{ label: 'A' }, { label: 'B' }];
	const refusals: [string, Spec, Parameters<typeof render>[1]?][] = [
		['an empty Markdown body', message({ markdown: '  ' })],
		['an empty blocks body', message({ blocks: [] })],
		['a body over 32,768 characters', message({ markdown: 'x'.repeat(32_769) })],
		['a body over 500 blocks', message({ blocks: Array.from({ length: 501 }, () => ({ type: 'paragraph' as const, text: 'x' })) })],
		['a question body over 3,500 characters', choice({ markdown: `${'x'.repeat(3_500)}?` }, options)],
		['one option', choice({ markdown: 'Which?' }, [{ label: 'A' }])],
		['9 options', choice({ markdown: 'Which?' }, Array.from({ length: 9 }, (_, n) => ({ label: `O${n}` })))],
		['an empty label', choice({ markdown: 'Which?' }, [{ label: '' }, { label: 'B' }])],
		['a label of 47 characters', choice({ markdown: 'Which?' }, [{ label: 'x'.repeat(47) }, { label: 'B' }])],
		['attach with no file', message({ markdown: 'Files.' }, { attach: [] })],
		['attach with 11 files', message({ markdown: 'Files.' }, { attach: Array.from({ length: 11 }, (_, n) => ({ path: `/p/${n}.png` })) })],
		['a caption of 1,025 characters', message({ markdown: 'Files.' }, { attach: [{ path: '/p/a.png', caption: 'x'.repeat(1_025) }] })],
		['a tab without a view', choice({ markdown: 'Which?' }, [{ label: 'A', tab: 'A' }, { label: 'B' }])],
		['a ref outside its pattern', choice({ markdown: 'Which?' }, options), { chat: CHAT, ref: 'no spaces' }],
		['a question without a ref', choice({ markdown: 'Which?' }, options), { chat: CHAT }],
		['a view id outside its pattern', message({ markdown: 'Diff.' }, { view: 'short' }), { chat: CHAT, viewOrigin: ORIGIN }],
		['a view without a view origin', message({ markdown: 'Diff.' }, { view: VIEW }), { chat: CHAT }],
		['a view origin that is not an https origin', message({ markdown: 'Diff.' }, { view: VIEW }), { chat: CHAT, viewOrigin: 'http://views.example.com/path' }],
		['a question body with </details>', text({ markdown: '<details><summary>a</summary>b</details>\n\nOK?' })],
		['an HTML question body with </DETAILS>', text({ html: '<details>b</DETAILS> OK?' })],
		['a question body with an odd number of code fences', text({ markdown: '```\ncode\n\nOK?' })],
	];
	for (const [name, spec, context] of refusals) {
		test(`refuses ${name}`, () => {
			expect(() => render(spec, context ?? at)).toThrow(ShapeError);
		});
	}

	test('accepts the limits themselves', () => {
		expect(() => render(message({ markdown: 'x'.repeat(32_768) }), at)).not.toThrow();
		expect(() => render(choice({ markdown: `${'x'.repeat(3_499)}?` }, [{ label: 'x'.repeat(46) }, ...Array.from({ length: 7 }, (_, n) => ({ label: `O${n}` }))]), at)).not.toThrow();
		expect(() => render(message({ markdown: 'Files.' }, { attach: Array.from({ length: 10 }, (_, n) => ({ path: `/p/${n}.png`, caption: 'x'.repeat(1_024) })) }), at)).not.toThrow();
		expect(() => render(text({ markdown: '```\ncode\n```\n\nOK?' }), at)).not.toThrow();
		// A plain message may close a details block of its own.
		expect(() => render(message({ markdown: '<details><summary>a</summary>b</details>' }), at)).not.toThrow();
	});
});

describe('warnings', () => {
	const codes = (spec: Spec) => render(spec, at).warnings.map((warning) => warning.code);

	test('no-question-mark: the last line of a question ends without ?, ？ or ؟', () => {
		expect(codes(text({ markdown: 'Tell me the commit message' }))).toEqual(['no-question-mark']);
		expect(codes(text({ markdown: '**Ready?**' }))).toEqual([]);
		expect(codes(text({ markdown: '準備できた？' }))).toEqual([]);
		expect(codes(text({ markdown: 'جاهز؟' }))).toEqual([]);
		expect(codes(text({ markdown: 'Ready?\n\n```\nlog\n```' }))).toEqual([]);
		expect(codes(text({ blocks: [{ type: 'paragraph', text: 'Ready?' }, { type: 'pre', text: 'log' }] }))).toEqual([]);
		expect(codes(message({ markdown: 'Done' }))).toEqual([]);
	});

	test('table-candidate: 3 consecutive lines of name: value outside code and quotes', () => {
		expect(codes(message({ markdown: 'Branch: main\nCommits: 4\nChecks: pass' }))).toEqual(['table-candidate']);
		expect(codes(message({ markdown: 'Branch: main\nCommits: 4\n\nChecks: pass' }))).toEqual([]);
		expect(codes(message({ markdown: '```\nBranch: main\nCommits: 4\nChecks: pass\n```' }))).toEqual([]);
		expect(codes(message({ markdown: '> Branch: main\n> Commits: 4\n> Checks: pass' }))).toEqual([]);
	});

	test('answer-hint: a question holds a hint word as a whole word', () => {
		expect(codes(choice({ markdown: 'Tap a button: merge now?' }, [{ label: 'A' }, { label: 'B' }]))).toEqual(['answer-hint']);
		expect(codes(text({ markdown: 'Should the tapping stop?' }))).toEqual([]);
		expect(codes(message({ markdown: 'Tap the screen.' }))).toEqual([]);
		expect(render(text({ markdown: 'Drück den Knopf?' }), { ...at, labels: { ...defaultLabels, hintWords: ['knopf'] } }).warnings.map((w) => w.code)).toEqual(['answer-hint']);
	});
});

describe('renderEdit of a sent message', () => {
	test('an edit of a plain message carries its body and keeps its view row', () => {
		const sent = { chat: CHAT, message: 640, files: [], view: { id: VIEW, origin: ORIGIN } };
		expect(renderEdit({ sent, body: { markdown: 'Step 2 of 5' } })).toEqual({
			method: 'editMessageText',
			payload: { chat_id: CHAT, message_id: 640, rich_message: { markdown: 'Step 2 of 5' }, reply_markup: { inline_keyboard: [[{ text: defaultLabels.view, web_app: { url: `${ORIGIN}/?v=${VIEW}` } }]] } },
		});
	});
});

describe('every edit body can go out', () => {
	test('an empty or oversized plain edit is refused', () => {
		const sent = { chat: CHAT, message: 640, files: [] };
		expect(() => renderEdit({ sent, body: { markdown: '' } })).toThrow(ShapeError);
		expect(() => renderEdit({ sent, body: { blocks: Array.from({ length: 501 }, () => ({ type: 'divider' as const })) } })).toThrow(ShapeError);
	});

	test('a resolved form over 500 blocks is the new body alone', () => {
		const many = Array.from({ length: 500 }, () => ({ type: 'paragraph' as const, text: 'x' }));
		const question = asked(text({ blocks: many }));
		const closed = step(step(question, { type: 'sent', sent: sentFor(question) }), { type: 'close', body: { blocks: [{ type: 'paragraph', text: 'Done' }] } });
		const shown = renderEdit(closed).payload.rich_message as Body;
		expect(shown).toEqual({ blocks: [{ type: 'paragraph', text: 'Done' }] });
		expect(() => render(message(shown), { chat: CHAT })).not.toThrow();
		// Expiry follows the same rule.
		const expiring = asked(text({ blocks: many }), { expiresAt: NOW + 1 });
		const expired = step(step(expiring, { type: 'sent', sent: sentFor(expiring) }), { type: 'delivered', seq: 0 }, NOW + 1);
		expect(renderEdit(expired).payload.rich_message).toEqual({ blocks: [{ type: 'paragraph', text: defaultLabels.expired }] });
	});

	test('a resolved form within the limits keeps the quoted original', () => {
		const question = asked(text({ blocks: [{ type: 'paragraph', text: 'Why?' }] }));
		const closed = step(step(question, { type: 'sent', sent: sentFor(question) }), { type: 'close', body: { blocks: [{ type: 'paragraph', text: 'Done' }] } });
		expect(renderEdit(closed).payload.rich_message).toEqual({ blocks: [{ type: 'paragraph', text: 'Done' }, { type: 'details', summary: defaultLabels.question, blocks: [{ type: 'paragraph', text: 'Why?' }] }] });
	});
});

describe('builders', () => {
	test('yesNo answers with the values yes and no', () => {
		const spec = yesNo({ markdown: 'Ship it?' }, { labels: { yes: 'Ja', no: 'Nein' }, once: true });
		expect(spec.answer).toEqual({ type: 'choice', options: [{ label: 'Ja', value: 'yes' }, { label: 'Nein', value: 'no' }], layout: 'row', once: true });
	});
});

describe('warnings read visible text', () => {
	const codes = (spec: Spec) => render(spec, at).warnings.map((warning) => warning.code);

	test('a Markdown link counts as its label', () => {
		expect(codes(text({ markdown: '[Ready?](https://example.com)' }))).toEqual([]);
		expect(codes(text({ markdown: 'See [the diff][1]. Ready?\n\n[1]: https://example.com/diff' }))).toEqual([]);
		expect(codes(text({ markdown: 'See [the diff](https://example.com/a?b).' }))).toEqual(['no-question-mark']);
		expect(codes(text({ markdown: 'Open [Ready?][1]' }))).toEqual([]);
		expect(codes(text({ markdown: '[tap here](https://example.com) to see it?' }))).toEqual(['answer-hint']);
		expect(codes(text({ markdown: 'Read [the report](https://example.com/tap) first?' }))).toEqual([]);
	});
});
