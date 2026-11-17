// Publishes one probe view and sends its Web App button, or reads back what the phone reported.
// Run: ORIGIN=https://... READ_KEY=... TELEGRAM_BOT_TOKEN=... CHAT=... bun facts/view-probe/publish.ts
//      ORIGIN=https://... READ_KEY=... bun facts/view-probe/publish.ts reports <id>
// The first form PUTs `{ markdown, page }` under a new id, sends the button at once and prints the
// time between the two answers, so a 404 retry count in the report shows how long the store lagged.
import { readFile } from 'node:fs/promises';

const origin = process.env.ORIGIN?.replace(/\/+$/, '');
const readKey = process.env.READ_KEY;
if (!origin || !readKey) throw new Error('ORIGIN and READ_KEY are required');
const bearer = { Authorization: `Bearer ${readKey}` };

async function read(path: string): Promise<unknown> {
	const response = await fetch(`${origin}${path}`, { headers: bearer });
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response.json();
}

if (process.argv[2] === 'reports') {
	const id = process.argv[3];
	if (!id) throw new Error('usage: bun publish.ts reports <id>');
	console.log(JSON.stringify({ reports: await read(`/api/reports?v=${id}`), hits: await read('/api/hits') }, null, '\t'));
} else {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chat = process.env.CHAT;
	if (!token || !chat) throw new Error('TELEGRAM_BOT_TOKEN and CHAT are required');

	// 16 random bytes are 22 base64url characters without padding.
	const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
	const page = (await readFile(new URL('./page.html', import.meta.url), 'utf8')).replaceAll('ORIGIN', origin);
	const markdown = ['View probe', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '<b>stays text</b> <script>alert(1)</script>'].join('\n');

	const put = await fetch(`${origin}/api/view/${id}`, { method: 'PUT', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown, page }) });
	const putAt = performance.now();
	if (!put.ok) throw new Error(`PUT: ${put.status} ${await put.text()}`);

	const send = await fetch(`https://api.telegram.org/bot${token}/sendRichMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chat,
			rich_message: { markdown: `View probe ${id}` },
			reply_markup: { inline_keyboard: [[{ text: 'Open view', web_app: { url: `${origin}/?v=${id}` } }]] },
		}),
	});
	const sentAt = performance.now();
	const answer: unknown = await send.json();
	if (!send.ok) throw new Error(`sendRichMessage: ${send.status} ${JSON.stringify(answer)}`);
	console.log(JSON.stringify({ id, put: await put.json(), putToSendMs: Math.round(sentAt - putAt) }, null, '\t'));
}
