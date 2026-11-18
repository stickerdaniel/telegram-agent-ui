// A store on a case-insensitive volume, such as case-insensitive APFS, finds the file of `q:probe001`
// for the key `q:PROBE001`. The chat treats a question loaded under another spelling of its ref as
// absent, so such an alias reads, closes, answers and overwrites no other question.
import { expect, test } from 'bun:test';
import { choice } from '../core/builders.ts';
import type { Store } from '../core/types.ts';
import { CHAT, REF, tap } from '../fixtures.ts';
import { memoryStore } from '../store/memory.ts';
import { fakeCall } from '../testing/index.ts';
import { createChat } from './create.ts';

/** A store that reads and writes every key in lower case, as a case-insensitive file system names files. */
function caseInsensitive(inner: Store): Store {
	const fold = (key: string) => key.toLowerCase();
	return {
		get: (key) => inner.get(fold(key)),
		set: (key, value) => inner.set(fold(key), value),
		delete: (key) => inner.delete(fold(key)),
		list: (prefix) => inner.list(fold(prefix)),
		lock: (key, fn) => inner.lock(fold(key), fn),
	};
}

test('a ref that differs only in letter case reaches no stored question', async () => {
	const store = caseInsensitive(memoryStore());
	const chat = createChat({ call: fakeCall().call, store, chat: CHAT });
	const spec = choice({ markdown: 'Deploy now?' }, [{ label: 'Deploy' }, { label: 'Wait' }]);
	const sent = await chat.send(spec, { ref: REF });
	expect(sent).toMatchObject({ kind: 'ok', status: 'pending' });
	const alias = REF.toUpperCase();

	expect(await chat.get(alias)).toBeUndefined();
	expect(await chat.close(alias)).toMatchObject({ kind: 'refused', code: 'unknown-ref' });
	// Asked again under the alias, the send writes nothing over the stored question.
	expect(await chat.send(spec, { ref: alias })).toMatchObject({ kind: 'refused', code: 'ref-conflict' });
	const message = sent.kind === 'ok' && sent.sent ? sent.sent.message : 0;
	expect(await chat.handle(tap({ button: 0, ref: alias, message }))).toMatchObject({ kind: 'stale', reason: 'unknown' });

	// The question itself is untouched and still takes its own answer.
	expect(await chat.get(REF)).toMatchObject({ ref: REF, status: 'open' });
	// Once it is answered, its answer comes back under its own ref and never under the alias.
	expect(await chat.handle(tap({ button: 0, ref: REF, message }))).toMatchObject({ kind: 'answered' });
	expect((await chat.wait(REF, { seconds: 0 })).answer).toBeDefined();
	expect((await chat.wait(alias, { seconds: 0 })).answer).toBeUndefined();
});
