// Topics of the private chat, see 5.2: make one, list the icons a topic may have, and set a
// topic's icon. A caller is whatever the consumer maps to a topic: the package keeps no map of
// callers. Each function first reads topic mode from getMe and refuses with `no-topics` while
// `has_topics_enabled` is false or missing. Success is the Bot API's answer; a client may draw
// a new icon later.
import { isInt, isRecord, isString } from '../core/check.ts';
import { classify } from '../core/classify.ts';
import type { CallClass } from '../core/types.ts';
import type { Transport } from './fetch.ts';

/** Why a topic call did nothing. `busy` is a 429, `server` any other refusal or a getMe without an answer. */
export type TopicRefused = { kind: 'refused'; code: 'no-topics' | 'server' | 'token' | 'busy' | 'shape'; reason: string };
/** A call that got no answer and may have arrived. */
export type TopicUncertain = { kind: 'uncertain'; reason: string };
/** An icon a topic may have: the custom emoji id that `setTopicIcon` takes, and the emoji it looks like. */
export type TopicIcon = { id: string; emoji: string };

/** A topic's name has 1 to 128 characters. */
export const TOPIC_NAME = { most: 128 } as const;
const NOT_MODIFIED = 'TOPIC_NOT_MODIFIED';

const refused = (code: TopicRefused['code'], reason: string): TopicRefused => ({ kind: 'refused', code, reason });

/** A refusal for an answer that is no success. */
function failure(result: Exclude<CallClass, { kind: 'ok' }>, method: string): TopicRefused | TopicUncertain {
	if (result.kind === 'refused') return refused(result.code, `${method} was refused: ${result.reason}`);
	if (result.kind === 'retry') return refused('busy', `${method} asked to wait: try again later`);
	return { kind: 'uncertain', reason: `${method} got no answer` };
}

/** getMe's answer: topic mode on or off, or why it is unknown, a refused token included. */
async function readMode(call: Transport): Promise<boolean | TopicRefused | TopicUncertain> {
	const result = classify('getMe', await call({ method: 'getMe', payload: {} }));
	if (result.kind !== 'ok') return failure(result, 'getMe');
	if (!isRecord(result.result)) return refused('server', 'getMe answered without a bot');
	return result.result.has_topics_enabled === true;
}

/** Whether getMe reports topic mode in private chats: true, false, or undefined when getMe got no usable answer. */
export async function topicMode(call: Transport): Promise<boolean | undefined> {
	const mode = await readMode(call);
	return typeof mode === 'boolean' ? mode : undefined;
}

/** Undefined while topic mode is on, else the refusal: `no-topics`, `token` for a refused token, or why getMe told nothing. */
async function needTopics(call: Transport): Promise<TopicRefused | undefined> {
	const mode = await readMode(call);
	if (mode === true) return undefined;
	if (mode === false) return refused('no-topics', 'the bot has no topic mode in private chats: a person turns it on in @BotFather');
	return mode.kind === 'refused' ? mode : refused('server', `${mode.reason}, so topic mode is unknown`);
}

/** The icons of getForumTopicIconStickers, or the refusal. */
async function icons(call: Transport): Promise<{ kind: 'ok'; icons: TopicIcon[] } | TopicRefused | TopicUncertain> {
	const result = classify('getForumTopicIconStickers', await call({ method: 'getForumTopicIconStickers', payload: {} }));
	if (result.kind !== 'ok') return failure(result, 'getForumTopicIconStickers');
	const stickers = Array.isArray(result.result) ? result.result : [];
	return {
		kind: 'ok',
		icons: stickers.flatMap((sticker): TopicIcon[] => (isRecord(sticker) && isString(sticker.custom_emoji_id) ? [{ id: sticker.custom_emoji_id, emoji: isString(sticker.emoji) ? sticker.emoji : '' }] : [])),
	};
}

/**
 * Makes a topic `name` in the private chat `chat` with createForumTopic and returns its
 * `message_thread_id`. A lost answer is `uncertain` and is not sent again, since a second call
 * could make a second topic.
 *
 *   await createTopic(call, 111, 'growth-desk'); // { kind: 'ok', topic: 42, name: 'growth-desk' }
 */
export async function createTopic(call: Transport, chat: number, name: string): Promise<{ kind: 'ok'; topic: number; name: string } | TopicRefused | TopicUncertain> {
	if (!isString(name) || name.length < 1 || name.length > TOPIC_NAME.most) return refused('shape', `a topic name has 1 to ${TOPIC_NAME.most} characters`);
	const off = await needTopics(call);
	if (off) return off;
	const result = classify('createForumTopic', await call({ method: 'createForumTopic', payload: { chat_id: chat, name } }));
	if (result.kind !== 'ok') return failure(result, 'createForumTopic');
	const topic = isRecord(result.result) && isInt(result.result.message_thread_id) ? result.result.message_thread_id : undefined;
	if (topic === undefined) return { kind: 'uncertain', reason: 'createForumTopic answered without a message_thread_id' };
	return { kind: 'ok', topic, name: isRecord(result.result) && isString(result.result.name) ? result.result.name : name };
}

/**
 * The icons a topic may have, from getForumTopicIconStickers.
 *
 *   await topicIcons(call); // { kind: 'ok', icons: [{ id: '5312536423851630001', emoji: '💡' }, ...] }
 */
export async function topicIcons(call: Transport): Promise<{ kind: 'ok'; icons: TopicIcon[] } | TopicRefused | TopicUncertain> {
	const off = await needTopics(call);
	return off ?? icons(call);
}

/**
 * Sets the icon of topic `topic` in the private chat `chat` with editForumTopic, after checking
 * that `icon` is one of getForumTopicIconStickers. An icon the topic has already, which Telegram
 * answers with TOPIC_NOT_MODIFIED, counts as done with `changed: false`.
 *
 *   await setTopicIcon(call, 111, 42, '5312536423851630001'); // { kind: 'ok', changed: true }
 */
export async function setTopicIcon(call: Transport, chat: number, topic: number, icon: string): Promise<{ kind: 'ok'; changed: boolean } | TopicRefused | TopicUncertain> {
	if (!isInt(topic) || topic < 1) return refused('shape', 'a topic id is a positive message_thread_id');
	const off = await needTopics(call);
	if (off) return off;
	const allowed = await icons(call);
	if (allowed.kind !== 'ok') return allowed;
	if (!allowed.icons.some((known) => known.id === icon)) return refused('shape', `${icon} is no icon a topic may have: topic icons lists them`);
	const response = await call({ method: 'editForumTopic', payload: { chat_id: chat, message_thread_id: topic, icon_custom_emoji_id: icon } });
	if (!('noAnswer' in response) && !response.ok && response.description.includes(NOT_MODIFIED)) return { kind: 'ok', changed: false };
	const result = classify('editForumTopic', response);
	return result.kind === 'ok' ? { kind: 'ok', changed: true } : failure(result, 'editForumTopic');
}
