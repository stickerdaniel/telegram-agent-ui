import { expect, test } from 'bun:test';
import caption from '../../facts/records/08-caption-1025.json';
import conflict from '../../facts/records/05-two-polls.json';
import { responses } from '../fixtures.ts';
import { classify } from './classify.ts';

// The rows of the outcome table of 4.5.
test('success is ok with its result', () => {
	expect(classify('sendRichMessage', responses.send)).toEqual({ kind: 'ok', result: (responses.send as { result: unknown }).result });
});

test('the recorded 400 "message is not modified" is unchanged for an edit', () => {
	expect(classify('editMessageText', responses.notModified)).toEqual({ kind: 'unchanged' });
	expect(classify('sendRichMessage', responses.notModified)).toEqual({ kind: 'refused', code: 'server', reason: responses.notModified.description });
});

test('any other 4xx except 401 and 429 is refused: server', () => {
	expect(classify('sendPhoto', { ok: false, status: caption.status, description: caption.body.description })).toEqual({ kind: 'refused', code: 'server', reason: 'Bad Request: message caption is too long' });
	expect(classify('getUpdates', { ok: false, status: conflict.first.status, description: conflict.first.body.description })).toMatchObject({ kind: 'refused', code: 'server' });
	expect(classify('editMessageText', { ok: false, status: 403, description: 'Forbidden: bot was blocked by the user' })).toMatchObject({ kind: 'refused', code: 'server' });
});

test('401 is refused: token', () => {
	expect(classify('sendRichMessage', { ok: false, status: 401, description: 'Unauthorized' })).toEqual({ kind: 'refused', code: 'token', reason: 'Unauthorized' });
});

test('429 is retry, at the time the transport reports', () => {
	expect(classify('editMessageText', { ok: false, status: 429, description: 'Too Many Requests: retry after 3', retryAfter: 1_794_908_516_000 })).toEqual({ kind: 'retry', at: 1_794_908_516_000 });
	expect(classify('editMessageText', { ok: false, status: 429, description: 'Too Many Requests' })).toEqual({ kind: 'retry' });
});

test('5xx and no answer are uncertain', () => {
	expect(classify('sendRichMessage', { ok: false, status: 500, description: 'Internal Server Error' })).toEqual({ kind: 'uncertain' });
	expect(classify('sendMediaGroup', { ok: false, status: 502, description: 'Bad Gateway' })).toEqual({ kind: 'uncertain' });
	expect(classify('sendRichMessage', { noAnswer: true })).toEqual({ kind: 'uncertain' });
});
