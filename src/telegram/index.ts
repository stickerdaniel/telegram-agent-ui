// The Bot API adapter for Node and Bun: `fetchCall`, a transport over the Fetch API, and
// `listen`, the one loop that calls getUpdates, with `applyChoices`, its pass over the choices
// made in views. `fetchFile` downloads a file the human sent, and the topic functions make and
// mark the topics of the private chat.
export { CLOUD_API, type Download, fetchCall, fileDownload, type Transport } from './fetch.ts';
export { FETCH_LIMITS, type Fetched, type FetchRefused, fetchFile, type FileSource } from './fetch-file.ts';
export { admitted, type FileRecord, type MessageFile, type Occurrence, sourceOf } from './inbound.ts';
export { applyChoices, type ChoicePass, type Cursor, type Inbound, type InboundUpdate, KEEP_CLOSED, listen, type ListenOptions, MISSED_AFTER, POLL_TIMEOUT, type Stopped } from './listen.ts';
export type { InboundFile } from './messages.ts';
export { createTopic, setTopicIcon, type TopicIcon, topicIcons, type TopicRefused, type TopicUncertain, topicMode } from './topics.ts';
export { LANES, type UpdateHandled } from './updates.ts';
