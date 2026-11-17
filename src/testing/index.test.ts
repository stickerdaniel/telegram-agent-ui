import { expect, test } from 'bun:test';
import { memoryStore } from '../store/memory.ts';
import { fakeCall, faultyStore, StoreFault } from './index.ts';

test('fakeCall records every call and answers from its script, then like the Bot API', async () => {
	const telegram = fakeCall([{ noAnswer: true }, () => ({ ok: false, status: 429, description: 'Too Many Requests' })]);
	const send = { method: 'sendRichMessage', payload: { chat_id: 111, rich_message: { markdown: 'Hi' } } };
	expect(await telegram.call(send)).toEqual({ noAnswer: true });
	expect(await telegram.call(send)).toEqual({ ok: false, status: 429, description: 'Too Many Requests' });
	expect(await telegram.call(send)).toMatchObject({ ok: true, result: { message_id: 1001, chat: { id: 111 } } });
	expect(await telegram.call({ method: 'sendMediaGroup', payload: { chat_id: 111, media: [{}, {}, {}] } })).toMatchObject({ ok: true, result: [{ message_id: 1002 }, { message_id: 1003 }, { message_id: 1004 }] });
	expect(await telegram.call({ method: 'editMessageText', payload: { chat_id: 111, message_id: 1001 } })).toMatchObject({ ok: true, result: { message_id: 1001 } });
	expect(await telegram.call({ method: 'answerCallbackQuery', payload: {} }, { photo: 'opened' })).toEqual({ ok: true, result: true });
	expect(telegram.calls).toHaveLength(6);
	expect(telegram.calls[5]).toEqual({ call: { method: 'answerCallbackQuery', payload: {} }, files: { photo: 'opened' } });
});

test('faultyStore fails the chosen call before or after it runs', async () => {
	const store = faultyStore(memoryStore());
	store.fail('set', 'before');
	await expect(store.set('a', 1)).rejects.toBeInstanceOf(StoreFault);
	expect(await store.get('a')).toBeUndefined();
	store.fail('set', 'after', 2);
	await store.set('a', 1);
	await expect(store.set('b', 2)).rejects.toBeInstanceOf(StoreFault);
	expect(await store.get('b')).toBe(2);
	store.fail('lock', 'after');
	let ran = false;
	await expect(
		store.lock('q:a', async () => {
			ran = true;
		}),
	).rejects.toBeInstanceOf(StoreFault);
	expect(ran).toBe(true);
	expect(store.ops.map((op) => op.method)).toEqual(['set', 'get', 'set', 'set', 'get', 'lock']);
});

test('faultyStore fails get, delete and list too', async () => {
	const store = faultyStore(memoryStore());
	await store.set('q:a', 1);
	store.fail('get', 'before');
	await expect(store.get('q:a')).rejects.toBeInstanceOf(StoreFault);
	store.fail('get', 'after');
	await expect(store.get('q:a')).rejects.toBeInstanceOf(StoreFault);
	store.fail('list', 'before');
	await expect(store.list('q:')).rejects.toBeInstanceOf(StoreFault);
	expect(await store.list('q:')).toEqual(['q:a']);
	store.fail('delete', 'before');
	await expect(store.delete('q:a')).rejects.toBeInstanceOf(StoreFault);
	expect(await store.get('q:a')).toBe(1);
	store.fail('delete', 'after');
	await expect(store.delete('q:a')).rejects.toBeInstanceOf(StoreFault);
	expect(await store.get('q:a')).toBeUndefined();
});

test('faultyStore fails list after it ran and lock before its task runs', async () => {
	const store = faultyStore(memoryStore());
	await store.set('q:a', 1);
	store.fail('list', 'after');
	await expect(store.list('q:')).rejects.toBeInstanceOf(StoreFault);
	let ran = false;
	store.fail('lock', 'before');
	await expect(
		store.lock('q:a', async () => {
			ran = true;
		}),
	).rejects.toBeInstanceOf(StoreFault);
	expect(ran).toBe(false);
	expect(await store.lock('q:a', async () => 'free')).toBe('free');
});
