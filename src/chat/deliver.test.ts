// `flush` delivers answers to `onAnswer`: at least once, the newest answer, retried per pass,
// undelivered after 5 rejections until the seq rises or `flush({ restart: true })` renews them.
// It is serial per chat. `wait` polls the store.
import { describe, expect, test } from 'bun:test';
import { choice, text } from '../core/builders.ts';
import { defaultLabels } from '../core/types.ts';
import { CHAT, NOW, REF, reply, tap } from '../fixtures.ts';
import { type Chat, createChat, type Delivered, DELIVERY_ATTEMPTS } from './create.ts';
import { setup } from './harness.ts';

const BODY = 1001;
const deploy = choice({ markdown: 'Deploy now?' }, [{ label: 'Deploy' }, { label: 'Wait' }]);

/** Waits until `condition` holds, polling every 2 ms, for at most 10 s. */
async function until(condition: () => boolean) {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('the condition was not reached in 10 s');
		await Bun.sleep(2);
	}
}

/** A chat whose onAnswer records each delivery and runs `consumer` on it. */
function delivering(consumer: (answer: Delivered, chat: Chat) => Promise<void> = async () => {}) {
	const got: Delivered[] = [];
	const holder: { chat?: Chat } = {};
	const env = setup({
		onAnswer: async (answer) => {
			got.push(answer);
			if (holder.chat) await consumer(answer, holder.chat);
		},
	});
	holder.chat = env.chat;
	return { ...env, got };
}

describe('onAnswer', () => {
	test('an answer is delivered once with its idempotency key and meta', async () => {
		const { chat, got, breaches } = delivering();
		await chat.send(deploy, { ref: REF, meta: { session: 's1' } });
		await chat.handle(tap({ button: 0, message: BODY }));
		await chat.flush();
		await chat.flush();
		expect(got).toEqual([
			{ kind: 'answered', ref: REF, seq: 1, answer: { kind: 'choice', index: 0, label: 'Deploy' }, by: { id: CHAT, name: expect.any(String) }, at: NOW, meta: { session: 's1' }, delivery: `${REF}:1` },
		]);
		expect((await chat.get(REF))?.delivery).toEqual({ seq: 1, attempts: 0 });
		expect(breaches).toEqual([]);
	});

	test('delivery is at least once: a delivery whose record failed is delivered again', async () => {
		const { chat, store, got } = delivering();
		await chat.send(deploy, { ref: REF });
		await chat.handle(tap({ button: 0, message: BODY }));
		// The pass reads and writes nothing before the delivery; the next set is the delivered record.
		store.fail('set', 'before');
		await expect(chat.flush()).rejects.toThrow('failed before it ran');
		await chat.flush();
		expect(got.map((answer) => answer.delivery)).toEqual([`${REF}:1`, `${REF}:1`]);
		expect((await chat.get(REF))?.delivery.seq).toBe(1);
	});

	test('two answers before a flush deliver the newest, with the previous one', async () => {
		const { chat, got } = delivering();
		await chat.send(deploy, { ref: REF });
		await chat.handle(tap({ button: 0, id: 'first', message: BODY }));
		await chat.handle(tap({ button: 1, id: 'second', message: BODY }));
		await chat.flush();
		expect(got).toMatchObject([{ seq: 2, answer: { index: 1, label: 'Wait' }, previous: { index: 0, label: 'Deploy' }, delivery: `${REF}:2` }]);
	});

	test('a rejected delivery is retried by the next pass', async () => {
		let reject = true;
		const { chat, got } = delivering(async () => {
			if (reject) throw new Error('the answer command exited 1');
		});
		await chat.send(text({ markdown: 'Why?' }), { ref: REF });
		await chat.handle(reply({ id: 900, replyTo: BODY, text: 'Because.', markupRef: null }));
		await chat.flush();
		expect((await chat.get(REF))?.delivery).toEqual({ seq: 0, attempts: 1, error: 'the answer command exited 1' });
		reject = false;
		await chat.flush();
		expect(got).toHaveLength(2);
		expect((await chat.get(REF))?.delivery).toEqual({ seq: 1, attempts: 0 });
	});

	test('after 5 rejections an answer is undelivered until a restart renews 5 attempts or its seq rises', async () => {
		const consumer = async () => {
			throw new Error('down');
		};
		const { chat, got, inner, server } = delivering(consumer);
		await chat.send(deploy, { ref: REF });
		await chat.handle(tap({ button: 0, message: BODY }));
		for (let pass = 0; pass < DELIVERY_ATTEMPTS + 2; pass++) await chat.flush();
		expect(got).toHaveLength(DELIVERY_ATTEMPTS);
		expect((await chat.get(REF))?.delivery).toMatchObject({ seq: 0, attempts: DELIVERY_ATTEMPTS });

		// A new chat alone renews nothing: only a listener start, flush({ restart: true }), does.
		const other: Delivered[] = [];
		const listener = createChat({
			call: server.call,
			store: inner,
			chat: CHAT,
			now: () => NOW,
			onAnswer: async (answer) => {
				other.push(answer);
				throw new Error('still down');
			},
		});
		await listener.flush();
		expect(other).toEqual([]);
		await listener.flush({ restart: true });
		for (let pass = 0; pass < DELIVERY_ATTEMPTS + 2; pass++) await listener.flush();
		expect(other).toHaveLength(DELIVERY_ATTEMPTS);
		expect((await chat.get(REF))?.delivery).toMatchObject({ seq: 0, attempts: 2 * DELIVERY_ATTEMPTS });

		// A rising seq gets a fresh budget.
		await chat.handle(tap({ button: 1, id: 'correction', message: BODY }));
		await chat.flush();
		expect(got.at(-1)?.delivery).toBe(`${REF}:2`);
	});

	test('a consumer that compares seq with get(ref) before committing skips an answer corrected meanwhile', async () => {
		const committed: string[] = [];
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		const { chat, got } = delivering(async (answer, own) => {
			if (first) {
				first = false;
				await gate;
			}
			// The consumer's check: commit only the answer that is still current.
			if ((await own.get(answer.ref))?.seq === answer.seq) committed.push(answer.delivery);
		});
		await chat.send(deploy, { ref: REF });
		await chat.handle(tap({ button: 0, id: 'first', message: BODY }));
		const flushing = chat.flush();
		await until(() => got.length === 1);
		await chat.handle(tap({ button: 1, id: 'second', message: BODY }));
		release();
		await flushing;
		await chat.flush();
		expect(committed).toEqual([`${REF}:2`]);
		expect((await chat.get(REF))?.delivery).toEqual({ seq: 2, attempts: 0 });
	});
});

describe('flush', () => {
	test('is serial, and a call during a pass gets one more pass', async () => {
		let running = 0;
		let most = 0;
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { chat, got } = delivering(async (answer) => {
			running++;
			most = Math.max(most, running);
			if (answer.ref === 'b') await gate;
			running--;
		});
		await chat.send(deploy, { ref: 'a' });
		await chat.send(deploy, { ref: 'b' });
		await chat.handle(tap({ button: 0, ref: 'b', message: BODY + 1 }));
		// The pass delivers b and waits there; a is answered after the pass looked at it.
		const first = chat.flush();
		await until(() => got.length === 1);
		await chat.handle(tap({ button: 1, ref: 'a', message: BODY }));
		const second = chat.flush();
		// A second pass that ran beside the first would deliver a now.
		await Bun.sleep(50);
		expect(got.map((answer) => answer.delivery)).toEqual(['b:1']);
		release();
		await Promise.all([first, second]);
		expect(got.map((answer) => answer.delivery)).toEqual(['b:1', 'a:1']);
		expect(most).toBe(1);
	});

	test('closes a question past expiresAt with labels.expired and shows it', async () => {
		const { chat, clock, server } = setup();
		await chat.send(deploy, { ref: REF, expiresAt: NOW + 570_000 });
		clock.now = NOW + 570_000;
		await chat.flush();
		expect(await chat.get(REF)).toMatchObject({ status: 'closed', resolved: { markdown: defaultLabels.expired } });
		expect(server.shows.get(BODY)?.rich_message).toEqual({ markdown: `${defaultLabels.expired}\n\n<details><summary>${defaultLabels.question}</summary>\n\nDeploy now?\n\n</details>` });
	});

	test('retries an edit refused with 429 at its time, not before', async () => {
		const { chat, clock, server } = setup();
		await chat.send(deploy, { ref: REF });
		server.fail(server.count, { busy: NOW + 30_000 });
		await chat.close(REF);
		await chat.flush();
		expect(server.calls.map(({ call }) => call.method)).toEqual(['sendRichMessage', 'editMessageText']);
		clock.now = NOW + 30_000;
		await chat.flush();
		const question = await chat.get(REF);
		expect(server.calls.map(({ call }) => call.method)).toEqual(['sendRichMessage', 'editMessageText', 'editMessageText']);
		expect(question?.shown.done).toBe(question?.shown.want ?? -1);
	});
});

describe('wait', () => {
	test('returns at once while no answer is stored and no listener is alive', async () => {
		const { chat } = setup();
		await chat.send(deploy, { ref: REF });
		const started = Date.now();
		expect(await chat.wait(REF, { seconds: 50 })).toEqual({ status: 'pending', listener: { alive: false } });
		// At once: far below the 50 s it would wait for a live listener, with room for a loaded machine.
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	test('returns the answer once a live listener stores one, and pending at its deadline', async () => {
		const { chat, inner } = setup();
		await inner.set('listener', { v: 1, heartbeat: NOW });
		await chat.send(deploy, { ref: REF });
		const started = Date.now();
		expect(await chat.wait(REF, { seconds: 0.3 })).toEqual({ status: 'pending', listener: { alive: true } });
		expect(Date.now() - started).toBeGreaterThanOrEqual(300);
		setTimeout(() => void chat.handle(tap({ button: 1, message: BODY })), 100);
		expect(await chat.wait(REF)).toMatchObject({ status: 'answered', answer: { label: 'Wait' }, by: { id: CHAT }, listener: { alive: true } });
	});

	test('a closed question and a ref the store does not hold are closed', async () => {
		const { chat, inner } = setup();
		await inner.set('listener', { v: 1, heartbeat: NOW, stopped: 'a second poll ended this one' });
		await chat.send(deploy, { ref: REF });
		await chat.close(REF);
		expect(await chat.wait(REF)).toEqual({ status: 'closed', listener: { alive: false, stopped: 'a second poll ended this one' } });
		expect(await chat.wait('unknown')).toMatchObject({ status: 'closed' });
	});
});
