import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { bodyLike } from './render.ts';

const RECORDED: [input: string, returned: string][] = [
	['Escaped: \\</details\\> \\*not bold\\* \\_x\\_ \\`code\\` \\[a\\]\\(b\\) \\# h \\| p \\~ \\& \\!', 'Escaped: \\</details> *not bold* _x_ `code` [a](b) # h | p ~ \\& !'],
	['A: &lt;/details&gt; and &amp; and <b>x</b>', 'A: </details> and & and x'],
	['B: a < b & c > d </details> end', 'B: a < b & c > d  end'],
	['a \\\\ b', 'a \\ b'],
	['C:\\dir\\x', 'C:\\dir\\x'],
];

const DROPPED = new Set(['*', '_', '`', '[', ']', '(', ')', '#', '|', '~', '!', '>', '\\']);
const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&' };

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
			out += char + next;
			at += 2;
		} else if (/^&(lt|gt|amp);/.test(rest)) {
			const entity = rest.slice(0, rest.indexOf(';') + 1);
			out += ENTITIES[entity] ?? entity;
			at += entity.length;
		} else if (/^<\/?[a-z]+>/i.test(rest)) {
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
