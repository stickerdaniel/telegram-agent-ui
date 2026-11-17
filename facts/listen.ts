// Records the updates of a person's tap and reply. Run: TELEGRAM_BOT_TOKEN=... CHAT=... bun facts/listen.ts <seconds>
import { writeFile } from 'node:fs/promises';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.CHAT;
if (!token || !chat) throw new Error('TELEGRAM_BOT_TOKEN and CHAT are required');
const until = Date.now() + Number(process.argv[2] ?? 60) * 1000;

async function call(method: string, payload: Record<string, unknown>) {
	const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
	return (await response.json()) as { ok: boolean; result?: unknown };
}

const updates: unknown[] = [];
let offset: number | undefined;
while (Date.now() < until) {
	const batch = await call('getUpdates', { timeout: 10, offset, allowed_updates: ['message', 'callback_query'] });
	for (const update of (batch.result ?? []) as { update_id: number; callback_query?: { id: string } }[]) {
		offset = update.update_id + 1;
		updates.push(update);
		console.log(Object.keys(update).join(','));
		if (update.callback_query) await call('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: '✓ recorded' });
	}
}
await call('getUpdates', { timeout: 0, offset });
const text = JSON.stringify(updates, null, '\t')
	.replaceAll(chat, '111')
	.replaceAll(token.split(':')[0], '222')
	.replace(/"(first_name|last_name|username|language_code)": "[^"]*"/g, '"$1": "x"');
await writeFile(new URL('./records/09-human-updates.json', import.meta.url), `${text}\n`);
