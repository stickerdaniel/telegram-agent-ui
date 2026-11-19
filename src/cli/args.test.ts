import { expect, test } from 'bun:test';
import { findCommand } from '../commands/table.ts';
import { parseArgs } from './args.ts';

function parse(args: string[]) {
	const found = findCommand(args);
	if (!found) throw new Error(`no command in ${args.join(' ')}`);
	const parsed = parseArgs(found.command.params, found.rest);
	return parsed.ok ? { raw: parsed.raw, files: Object.fromEntries(parsed.files) } : parsed.message;
}

test('flags, short aliases, switches, lists and file arguments', () => {
	expect(parse(['ask', '-o', 'Merge', '--option=Wait', '--once', '--meta', '{"session":"s1"}', '--ref', 'merge1', 'q.md'])).toEqual({
		raw: { options: ['Merge', 'Wait'], once: true, meta: { session: 's1' }, ref: 'merge1' },
		files: { body: 'q.md' },
	});
	expect(parse(['ask', '--yes-no', '-'])).toEqual({ raw: { answer: 'yesNo' }, files: { body: '-' } });
	expect(parse(['wait', 'merge1', '--seconds', '50'])).toEqual({ raw: { ref: 'merge1', seconds: 50 }, files: {} });
	expect(parse(['listen', '--on-answer', 'route', '--meta-key', 'a', '--meta-key', 'b'])).toEqual({ raw: { onAnswer: 'route', metaKey: ['a', 'b'] }, files: {} });
	expect(parse(['send', '--', '--literal.md'])).toEqual({ raw: {}, files: { body: '--literal.md' } });
});

test('--file repeats, and --tab takes its label and every file up to the next flag', () => {
	expect(parse(['send', '--file', 'a.png', '--file', 'report.pdf', 'm.md'])).toEqual({ raw: { files: ['a.png', 'report.pdf'] }, files: { body: 'm.md' } });
	expect(parse(['view', 'put', '--tab', 'Notes', 'notes.md', '--tab', 'Shots', 'a.png', 'b.png', 'run.mp4', '--ttl', '3'])).toEqual({
		raw: {
			tabs: [
				{ label: 'Notes', file: 'notes.md' },
				{ label: 'Shots', file: 'a.png' },
				{ label: 'Shots', file: 'b.png' },
				{ label: 'Shots', file: 'run.mp4' },
			],
			ttl: 3,
		},
		files: {},
	});
	expect(parse(['view', 'put', '--tab', 'Shots'])).toBe('--tab needs <label> <file>');
});

test('optional positionals fill from the left once the required ones have theirs', () => {
	expect(parse(['close', 'merge1'])).toEqual({ raw: { ref: 'merge1' }, files: {} });
	expect(parse(['close', 'merge1', 'done.md'])).toEqual({ raw: { ref: 'merge1' }, files: { body: 'done.md' } });
	expect(parse(['edit', '--ref', 'merge1', 'new.md'])).toEqual({ raw: { ref: 'merge1' }, files: { body: 'new.md' } });
	expect(parse(['edit', '{"chat":111,"message":632,"files":[]}', 'new.md'])).toEqual({ raw: { sent: { chat: 111, message: 632, files: [] } }, files: { body: 'new.md' } });
});

test('every malformed argument list names its fault', () => {
	expect(parse(['send', '--loud', 'm.md'])).toBe('unknown flag --loud');
	expect(parse(['ask', '--yes-no', '--text', 'q.md'])).toBe('--yes-no and --text exclude each other');
	expect(parse(['ask', '--ref', 'a', '--ref', 'b', 'q.md'])).toBe('--ref is given twice');
	expect(parse(['wait', 'merge1', '--seconds', 'ten'])).toBe('--seconds needs an integer, not "ten"');
	expect(parse(['wait', 'merge1', '--seconds'])).toBe('--seconds needs a value');
	expect(parse(['ask', '--meta', '{', 'q.md'])).toBe('meta needs JSON, not "{"');
	expect(parse(['send'])).toBe('missing file or -');
	expect(parse(['close', 'merge1', 'done.md', 'extra'])).toBe('unexpected argument extra');
	expect(parse(['send', '--silent=yes', 'm.md'])).toBe('--silent takes no value');
});
