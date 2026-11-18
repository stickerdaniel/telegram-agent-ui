// What the human reads for each kind of tool call: the whole call, nothing left out. Inputs
// follow Claude Code's tool inputs and Codex's payloads, `{ command, description? }` for Bash and
// `{ command: <patch> }` for apply_patch (core/src/tools/approvals.rs and sandboxing.rs at 59ac39add).
import { expect, test } from 'bun:test';
import { approvalBody, readToolCall } from './hook.ts';

const request = (tool: string, input: unknown) => JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: input });
const head = (tool: string) => ({ type: 'paragraph', text: { type: 'bold', text: tool } }) as const;
const path = (text: string) => ({ type: 'paragraph', text: { type: 'code', text } }) as const;
const body = (client: 'claude' | 'codex', tool: string, input: unknown) => {
	const call = readToolCall(client, request(tool, input));
	return call && approvalBody(call);
};

test('a file tool shows its paths and its whole change, and every other field as JSON', () => {
	expect(body('claude', 'Write', { file_path: '/repo/b.md', content: 'a\nb\n' })).toEqual({ blocks: [head('Write'), path('/repo/b.md'), { type: 'pre', text: 'a\nb\n' }] });
	expect(body('claude', 'Edit', { file_path: '/repo/src/a.ts', old_string: 'one\ntwo', new_string: 'one\n2', replace_all: true })).toEqual({
		blocks: [head('Edit'), path('/repo/src/a.ts'), { type: 'pre', text: '-one\n-two\n+one\n+2', language: 'diff' }, { type: 'pre', text: '{\n  "replace_all": true\n}', language: 'json' }],
	});
	// The whole patch, and each file it names, an indented header included.
	const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '*** Move to: src/c.ts', '@@', '-old', '+new', '  *** Add File: src/b.ts', '+b', '*** Delete File: src/d.ts', '*** End Patch'].join('\n');
	expect(body('codex', 'apply_patch', { command: patch })).toEqual({
		blocks: [head('apply_patch'), path('src/a.ts'), path('src/c.ts'), path('src/b.ts'), path('src/d.ts'), { type: 'pre', text: patch, language: 'diff' }],
	});
});

test('a shell command shows whole with its other fields, and any other tool its whole input as JSON', () => {
	expect(body('codex', 'Bash', { command: 'curl https://example.com', description: 'network-access example.com' })).toEqual({
		blocks: [head('Bash'), { type: 'pre', text: 'curl https://example.com' }, { type: 'pre', text: '{\n  "description": "network-access example.com"\n}', language: 'json' }],
	});
	const input = { url: 'https://example.com', prompt: 'Summarize', nested: { list: [1, 2] } };
	expect(body('claude', 'WebFetch', input)).toEqual({ blocks: [head('WebFetch'), { type: 'pre', text: JSON.stringify(input, null, 2), language: 'json' }] });
	// An input whose fields break a known tool's types is shown whole too.
	expect(readToolCall('codex', request('Bash', { cmd: ['ls'] }))).toEqual({ tool: 'Bash', kind: 'other', input: { cmd: ['ls'] } });
	expect(readToolCall('claude', request('Write', { file_path: '/a', content: 1 }))).toEqual({ tool: 'Write', kind: 'other', input: { file_path: '/a', content: 1 } });
	// Claude Code sends an object as tool_input, and every client a tool name.
	expect(readToolCall('claude', request('Bash', 'ls'))).toBeUndefined();
	expect(readToolCall('claude', JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: '', tool_input: {} }))).toBeUndefined();
});
