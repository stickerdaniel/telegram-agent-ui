// Records Bot API facts the plan depends on. Run: TELEGRAM_BOT_TOKEN=... CHAT=... bun facts/probe.ts
// Writes one JSON file per fact to facts/records/, with the chat id and names replaced.
import { mkdir, writeFile } from 'node:fs/promises';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = Number(process.env.CHAT);
if (!token || !chat) throw new Error('TELEGRAM_BOT_TOKEN and CHAT are required');

type Reply = { status: number; body: unknown };

async function call(method: string, payload: Record<string, unknown>): Promise<Reply> {
	const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	});
	return { status: response.status, body: await response.json() };
}

/** Replaces what identifies the account: the chat id, user ids and names. */
function redact(value: unknown): unknown {
	const text = JSON.stringify(value)
		.replaceAll(String(chat), '111')
		.replaceAll(token.split(':')[0], '222')
		.replace(/"(first_name|last_name|username)":"[^"]*"/g, '"$1":"x"');
	return JSON.parse(text);
}

const out = new URL('./records/', import.meta.url);
await mkdir(out, { recursive: true });
async function record(name: string, value: unknown) {
	await writeFile(new URL(`${name}.json`, out), `${JSON.stringify(redact(value), null, '\t')}\n`);
	console.log(name);
}

const keyboard = {
	inline_keyboard: [
		[{ text: 'Rebase', callback_data: 'q:probe001:0', style: 'primary' }],
		[{ text: 'Merge', callback_data: 'q:probe001:1' }],
		[{ text: 'Close', callback_data: 'q:probe001:2', style: 'danger' }],
	],
};
const markdown = [
	'**Probe: a question with 3 options**',
	'',
	'| Branch | Commits | Checks |',
	'| --- | --- | --- |',
	'| `feat/views` | 4 | pass |',
	'| `fix/lock` | 1 | fail |',
	'',
	'<details><summary>Details</summary>',
	'',
	'The second branch fails 1 of 212 tests.',
	'',
	'</details>',
	'',
	'Which way for `fix/lock`?',
].join('\n');

const sent = await call('sendRichMessage', { chat_id: chat, rich_message: { markdown }, reply_markup: keyboard, disable_notification: true });
await record('01-send-rich-with-keyboard', sent);
const message = (sent.body as { result?: { message_id: number } }).result?.message_id;
if (!message) throw new Error('send failed');

// An edit that changes nothing.
const same = await call('editMessageText', { chat_id: chat, message_id: message, rich_message: { markdown }, reply_markup: keyboard });
await record('02-edit-unchanged', same);

// An edit with a new body and no reply_markup: does the keyboard stay?
const bare = await call('editMessageText', { chat_id: chat, message_id: message, rich_message: { markdown: `${markdown}\n\n_edited without a keyboard_` } });
await record('03-edit-without-reply-markup', bare);

// The keyboard again, with a mark on one button.
const marked = structuredClone(keyboard);
marked.inline_keyboard[0][0].text = '✓ Rebase';
const again = await call('editMessageText', { chat_id: chat, message_id: message, rich_message: { markdown }, reply_markup: marked });
await record('04-edit-with-mark', again);

// Two long polls on one token: the older one ends.
const first = call('getUpdates', { timeout: 20, allowed_updates: ['message', 'callback_query'] });
await new Promise((resolve) => setTimeout(resolve, 2000));
const second = await call('getUpdates', { timeout: 1, allowed_updates: ['message', 'callback_query'] });
await record('05-two-polls', { first: await first, second: { status: second.status, ok: (second.body as { ok: boolean }).ok } });

// A file as a reply to the body, and an album as a second reply to the same body.
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfHiEY0liH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYB/6uBS1sKgo0AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
async function upload(method: string, fields: Record<string, string>, files: Record<string, Uint8Array>): Promise<Reply> {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	for (const [key, value] of Object.entries(files)) form.set(key, new Blob([value], { type: 'image/png' }), `${key}.png`);
	const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form });
	return { status: response.status, body: await response.json() };
}
const reply = JSON.stringify({ message_id: message });
const media = JSON.stringify([
	{ type: 'photo', media: 'attach://a', caption: 'first' },
	{ type: 'photo', media: 'attach://b' },
	{ type: 'photo', media: 'attach://c' },
]);
await record('06-album-reply-to-body', await upload('sendMediaGroup', { chat_id: String(chat), media, reply_parameters: reply, disable_notification: 'true' }, { a: png, b: png, c: png }));
await record('07-document-reply-to-body', await upload('sendDocument', { chat_id: String(chat), reply_parameters: reply, disable_notification: 'true' }, { document: png }));
await record('08-caption-1025', await upload('sendPhoto', { chat_id: String(chat), caption: 'x'.repeat(1025), disable_notification: 'true' }, { photo: png }));
