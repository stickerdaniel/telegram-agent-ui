// The Bot API adapter for Node and Bun: `fetchCall`, a transport over the Fetch API, and
// `listen`, the one loop that calls getUpdates, with `applyChoices`, its pass over the choices
// made in views.
export { CLOUD_API, fetchCall, type Transport } from './fetch.ts';
export { applyChoices, type ChoicePass, type Inbound, KEEP_CLOSED, listen, type ListenOptions, MISSED_AFTER, POLL_TIMEOUT, type Stopped } from './listen.ts';
