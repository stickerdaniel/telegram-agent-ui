// How sendRichMessage reads escapes in Markdown, from 5 answers of the cloud Bot API recorded
// on 2026-11-17, and a check that a label escaped by the core reads back as the label.
import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { bodyLike } from './render.ts';

// The recorded inputs and the paragraph text each answer returned. A bold node is flattened to its text.
const RECORDED: [input: string, returned: string][] = [
	['Escaped: \\</details\\> \\*not bold\\* \\_x\\_ \\`code\\` \\[a\\]\\(b\\) \\# h \\| p \\~ \\& \\!', 'Escaped: \\</details> *not bold* _x_ `code` [a](b) # h | p ~ \\& !'],
	['A: &lt;/details&gt; and &amp; and <b>x</b>', 'A: </details> and & and x'],
	['B: a < b & c > d </details> end', 'B: a < b & c > d  end'],
	// facts/README.md on main, line 32: a doubled backslash reads as one, a single one before a letter stays.
	['a \\\\ b', 'a \\ b'],
	['C:\\dir\\x', 'C:\\dir\\x'],
];

// The backslash escapes the server drops, a doubled backslash included; `\<` and `\&` keep their backslash.
const DROPPED = new Set(['*', '_', '`', '[', ']', '(', ')', '#', '|', '~', '!', '>', '\\']);
const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&' };

/** The plain text the server shows for Markdown without other markup, as the records show it. */
function shown(markdown: string): string {
	let out = '';
	for (let at = 0; at < markdown.length; ) {
		const rest = markdown.slice(at);
		const char = markdown[at] ?? '';
		const next = markdown[at + 1] ?? '';
		if (char === '\\' && DROPPED.has(next)) {
			out += next;
			at += 2;
		} else if (char === '\\' && (next === '<' || next === '&')) {
			// Kept as written, and the character after it starts no tag or entity.
			out += char + next;
			at += 2;
		} else if (/^&(lt|gt|amp);/.test(rest)) {
			const entity = rest.slice(0, rest.indexOf(';') + 1);
			out += ENTITIES[entity] ?? entity;
			at += entity.length;
		} else if (/^<\/?[a-z]+>/i.test(rest)) {
			// A raw tag is read as HTML: `</details>` disappears, `<b>` makes bold.
			at += rest.indexOf('>') + 1;
		} else {
			out += char;
			at += 1;
		}
	}
	return out;
}

test('the model of the server reproduces the 5 recorded answers', () => {
	for (const [input, returned] of RECORDED) expect(shown(input)).toBe(returned);
});

test('a label escaped for Markdown reads back as the label', () => {
	const tricky = '</details> <b>x</b> & a < b > c *bold* _x_ `code` [a](b) # h | p ~ ! C:\\dir\\x \\*';
	const escaped = bodyLike({ markdown: '' }, tricky);
	if (!('markdown' in escaped)) throw new Error('not Markdown');
	expect(escaped.markdown).not.toMatch(/\\[<&]/);
	expect(shown(escaped.markdown)).toBe(tricky);
	const characters = fc.constantFrom(...'abltgmp <>&*_`[]()#|~!;/\\'.split(''));
	fc.assert(
		fc.property(fc.array(characters, { minLength: 1, maxLength: 200 }), (chars) => {
			const label = chars.join('');
			const body = bodyLike({ markdown: '' }, label);
			expect('markdown' in body ? shown(body.markdown) : undefined).toBe(label);
		}),
		{ numRuns: 500 },
	);
});
