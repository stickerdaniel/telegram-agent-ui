// What the view host stores, and the limits of 4.8 it checks on every upload itself. Each stored
// record is JSON and reads back only through its parse function, which runs the same checks, so
// a record that breaks them reads as missing. Keys:
//
//   v:<view id>                       the view, its committed generation, its media and its expiry
//   g:<view id>:<generation>          the media of one generation, which a media URL is served against
//   m:<view id>:<generation>:<index>  one media object, as bytes with its type
//   c:<view id>:<ref>                 the context of one question on the view: its body, and the binding of a question answered in it
//   a:<view id>:<ref>:<choice id>     one choice posted from the view: the option, the user and the host's time
import { arrayOf, isBool, isInt, isNat, isRecord, isString, optional, storable } from '../core/check.ts';
import { isBody, isUser } from '../core/guards.ts';
import { CHOICE_ID, LIMITS, questionBodyIssue, REF, VIEW_ID } from '../core/shape.ts';
import type { Body, ChoiceBinding, StoredView, User } from '../core/types.ts';

/** The version of this package, which `GET /api/version` reports. A test keeps it equal to package.json. */
export const VERSION = '0.0.0';
/** The view formats `v` this host accepts. */
export const VIEW_FORMATS: readonly number[] = [1];
/** What `GET /api/version` lists as `formats`: the view formats, and `answers` for the choices of 4.10. */
export const HOST_FORMATS: readonly (number | string)[] = [...VIEW_FORMATS, 'answers'];
/** How many choices the host stores for one ref before it answers 429, and how long a choice lives at least after its time. */
export const CHOICE_LIMITS = { perRef: 32, life: 86_400_000 } as const;

const MIB = 1024 * 1024;
const DAY = 86_400_000;
/** The limits of 4.8, and how far ahead of the host's clock a view or media object may expire: 365 days. */
export const VIEW_LIMITS = { tabs: [1, 8], label: 46, viewBytes: 2 * MIB, mediaBytes: 20 * MIB, media: 20, totalBytes: 50 * MIB, ahead: 365 * DAY } as const;

/** The media types of 4.8: the endings png, jpg, jpeg, webp, gif and mp4. */
export const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export const isMediaType = (value: unknown): value is MediaType => MEDIA_TYPES.some((type) => type === value);

/** A generation of a view's media: 1 to 32 characters of [A-Za-z0-9_-], chosen by the publisher. */
export const GENERATION = /^[A-Za-z0-9_-]{1,32}$/;
/** A media index in a path: 0 to 19, without leading zeros. */
export const INDEX = /^(0|[1-9]\d?)$/;

/** The storage keys of the table above. */
export const keys = {
	view: (id: string) => `v:${id}`,
	manifest: (id: string, generation: string) => `g:${id}:${generation}`,
	media: (id: string, generation: string, index: number) => `m:${id}:${generation}:${index}`,
	context: (id: string, ref: string) => `c:${id}:${ref}`,
	choice: (id: string, ref: string, choice: string) => `a:${id}:${ref}:${choice}`,
	/** The prefix of every choice of a ref, or of every choice at all. */
	choices: (id?: string, ref?: string) => (id !== undefined && ref !== undefined ? `a:${id}:${ref}:` : 'a:'),
};

/** The view id, ref and choice id of a choice key, or undefined for any other key. */
export function parseChoiceKey(key: string): { view: string; ref: string; id: string } | undefined {
	const [prefix, view, ref, id, ...rest] = key.split(':');
	if (prefix !== 'a' || rest.length > 0 || view === undefined || ref === undefined || id === undefined) return undefined;
	return VIEW_ID.test(view) && REF.test(ref) && CHOICE_ID.test(id) ? { view, ref, id } : undefined;
}

export type MediaEntry = { type: MediaType; size: number };
/** `v:<id>`: what `PUT /api/view/<id>` stored. Its write commits `generation`. */
export type ViewRecord = { v: 1; generation: string; expiresAt: number; media: MediaEntry[]; view: StoredView };
/** `g:<id>:<generation>`: the media of a committed generation. A replaced view keeps it until it expires. */
export type ManifestRecord = { v: 1; expiresAt: number; media: MediaEntry[] };
/** `c:<id>:<ref>`: the body of a question, shown above the view's tabs, and the binding of a question answered in the view. */
export type ContextRecord = { v: 1; expiresAt: number; body: Body; choice?: ChoiceBinding };
/** `a:<id>:<ref>:<choice id>`: one choice, kept until `expiresAt`. */
export type ChoiceRecord = { v: 1; expiresAt: number; index: number; user: User; at: number };

/**
 * The type of a media file by its leading bytes: PNG, JPEG, WebP, GIF or an MP4 `ftyp` box.
 * Undefined for anything else.
 */
export function sniff(bytes: Uint8Array): MediaType | undefined {
	const starts = (offset: number, ...expected: number[]) => expected.every((byte, index) => bytes[offset + index] === byte);
	if (starts(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
	if (starts(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (starts(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
	if (starts(0, 0x52, 0x49, 0x46, 0x46) && starts(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
	if (starts(4, 0x66, 0x74, 0x79, 0x70)) return 'video/mp4';
	return undefined;
}

const isMediaEntry = (value: unknown): value is MediaEntry => isRecord(value) && Object.keys(value).length === 2 && isMediaType(value.type) && isInt(value.size);

/** Why a list of media is refused, or undefined: at most 20, each of 1 byte to 20 MiB, 50 MiB together. */
export function mediaIssue(media: unknown): string | undefined {
	if (!arrayOf(isMediaEntry)(media)) return `media is a list of { type, size } with a type of ${MEDIA_TYPES.join(', ')}`;
	if (media.length > VIEW_LIMITS.media) return `a view has at most ${VIEW_LIMITS.media} media, this one ${media.length}`;
	if (media.some((entry) => entry.size < 1 || entry.size > VIEW_LIMITS.mediaBytes)) return `a media file has 1 byte to ${VIEW_LIMITS.mediaBytes} bytes`;
	const total = media.reduce((sum, entry) => sum + entry.size, 0);
	if (total > VIEW_LIMITS.totalBytes) return `the media of a view have at most ${VIEW_LIMITS.totalBytes} bytes, these ${total}`;
	return undefined;
}

/** Why a Markdown tab's map from image destination to media index is refused, or undefined: each index names an image of the view. */
function mapIssue(map: unknown, media: readonly MediaEntry[]): string | undefined {
	if (map === undefined) return undefined;
	if (!isRecord(map)) return 'the media of a Markdown tab map destinations to media indexes';
	for (const [destination, index] of Object.entries(map)) {
		if (!isNat(index)) return `the Markdown image ${destination} names no media index`;
		const entry = media[index];
		if (!entry) return `the Markdown image ${destination} names media ${index}, and the view has ${media.length}`;
		if (!entry.type.startsWith('image/')) return `the Markdown image ${destination} names media ${index}, which is ${entry.type}, no image`;
	}
	return undefined;
}

/** Why one tab's content is refused against the view's media, or undefined. */
function contentIssue(content: unknown, media: readonly MediaEntry[]): string | undefined {
	if (isRecord(content) && 'markdown' in content && Object.keys(content).every((key) => key === 'markdown' || key === 'media')) {
		return isString(content.markdown) ? mapIssue(content.media, media) : 'markdown is text';
	}
	if (!isRecord(content) || Object.keys(content).length !== 1) return 'a tab content is one of markdown, diff, page and gallery';
	if ('diff' in content) return isString(content.diff) ? undefined : 'diff is text';
	if ('page' in content) {
		if (!isString(content.page)) return 'page is text';
		return /<script/i.test(content.page) ? 'a page may hold no <script' : undefined;
	}
	if (!('gallery' in content) || !Array.isArray(content.gallery) || content.gallery.length === 0) return 'a gallery is a list of 1 or more media';
	for (const item of content.gallery) {
		if (!isRecord(item) || !isNat(item.media) || !isString(item.type) || !optional(isString)(item.caption)) return 'a gallery item is { media, type, caption? }';
		if (Object.keys(item).some((key) => key !== 'media' && key !== 'type' && key !== 'caption')) return 'a gallery item is { media, type, caption? }';
		const entry = media[item.media];
		if (!entry) return `a gallery names media ${item.media}, and the view has ${media.length}`;
		if (entry.type !== item.type) return `a gallery names media ${item.media} as ${item.type}, and it is ${entry.type}`;
	}
	return undefined;
}

/**
 * Why `view` is no stored view of format 1 with these media, or undefined: 1 to 8 tabs with
 * labels of 1 to 46 characters, unique in the view, each with one content, no `<script` in a
 * page, a Markdown media map and gallery items that name media entries of their type, and at
 * most 2 MiB as JSON.
 */
export function viewIssue(view: unknown, media: readonly MediaEntry[]): string | undefined {
	if (!isRecord(view) || !storable(view)) return 'the view is no JSON object';
	if (Object.keys(view).some((key) => key !== 'v' && key !== 'title' && key !== 'tabs')) return 'a view is { v, title?, tabs }';
	if (!optional(isString)(view.title)) return 'title is text';
	const { tabs } = view;
	if (!Array.isArray(tabs) || tabs.length < VIEW_LIMITS.tabs[0] || tabs.length > VIEW_LIMITS.tabs[1]) return `a view has ${VIEW_LIMITS.tabs[0]} to ${VIEW_LIMITS.tabs[1]} tabs`;
	const labels = new Set<string>();
	for (const tab of tabs) {
		if (!isRecord(tab) || Object.keys(tab).length !== 2 || !isString(tab.label)) return 'a tab is { label, content }';
		if (tab.label.length < 1 || tab.label.length > VIEW_LIMITS.label) return `a tab label has 1 to ${VIEW_LIMITS.label} characters: "${tab.label}"`;
		if (labels.has(tab.label)) return `the tab label "${tab.label}" is used twice`;
		labels.add(tab.label);
		const issue = contentIssue(tab.content, media);
		if (issue) return issue;
	}
	const bytes = new TextEncoder().encode(JSON.stringify(view)).length;
	if (bytes > VIEW_LIMITS.viewBytes) return `a view without its media has at most ${VIEW_LIMITS.viewBytes} bytes as JSON, this one ${bytes}`;
	return undefined;
}

/** `value` as a stored view, after `viewIssue` found nothing and its format is 1. */
const isStoredView = (value: unknown, media: readonly MediaEntry[]): value is StoredView => isRecord(value) && value.v === 1 && viewIssue(value, media) === undefined;

/** The JSON bytes a record is stored as. */
export const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The JSON value of stored bytes, or undefined for bytes that are no UTF-8 JSON. */
export function decode(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return undefined;
	}
}

/** A stored `v:<id>` record, or undefined when it breaks its type or a limit. */
export function parseViewRecord(value: unknown): ViewRecord | undefined {
	if (!isRecord(value) || value.v !== 1 || !isString(value.generation) || !GENERATION.test(value.generation) || !isNat(value.expiresAt)) return undefined;
	const { media, view } = value;
	if (mediaIssue(media) !== undefined || !arrayOf(isMediaEntry)(media) || !isStoredView(view, media)) return undefined;
	return { v: 1, generation: value.generation, expiresAt: value.expiresAt, media, view };
}

/** A stored `g:<id>:<generation>` record, or undefined. */
export function parseManifest(value: unknown): ManifestRecord | undefined {
	if (!isRecord(value) || value.v !== 1 || !isNat(value.expiresAt) || mediaIssue(value.media) !== undefined || !arrayOf(isMediaEntry)(value.media)) return undefined;
	return { v: 1, expiresAt: value.expiresAt, media: value.media };
}

/** Why a context body is refused, or undefined: a body a question may have, see section 8. */
export function contextIssue(body: unknown): string | undefined {
	if (!isBody(body)) return 'a context is a body: { markdown }, { html } or { blocks }';
	return questionBodyIssue(body);
}

const isBound = (value: unknown): value is ChoiceBinding['options'][number] =>
	isRecord(value) && Object.keys(value).length === 3 && isNat(value.index) && isString(value.label) && isString(value.tab);

/**
 * Why a binding is refused against the tab labels of its view, or undefined: 2 to 8 options of
 * distinct indexes below 8, each with a label of 1 to 46 characters and its own tab of the view,
 * `once`, an optional expiry and an optional `closed`.
 */
export function bindingIssue(binding: unknown, tabs: readonly string[]): string | undefined {
	if (!isRecord(binding) || Object.keys(binding).some((key) => key !== 'options' && key !== 'once' && key !== 'expiresAt' && key !== 'closed')) return 'a binding is { options, once, expiresAt?, closed? }';
	const { options } = binding;
	if (!isBool(binding.once) || !optional(isNat)(binding.expiresAt) || !optional(isBool)(binding.closed) || !arrayOf(isBound)(options)) return 'a binding is { options: [{ index, label, tab }], once, expiresAt?, closed? }';
	const [least, most] = LIMITS.options;
	if (options.length < least || options.length > most) return `a binding has ${least} to ${most} options, this one ${options.length}`;
	const seen = { indexes: new Set<number>(), tabs: new Set<string>() };
	for (const option of options) {
		if (option.index >= most || seen.indexes.has(option.index)) return `the option index ${option.index} is above ${most - 1} or named twice`;
		if (option.label.length < 1 || option.label.length > LIMITS.label) return `an option label has 1 to ${LIMITS.label} characters: "${option.label}"`;
		if (!tabs.includes(option.tab)) return `the view has no tab "${option.tab}"`;
		if (seen.tabs.has(option.tab)) return `the tab "${option.tab}" is bound twice`;
		seen.indexes.add(option.index);
		seen.tabs.add(option.tab);
	}
	return undefined;
}

/** True for a binding that `bindingIssue` finds sound against `tabs`. */
export const isBinding = (value: unknown, tabs: readonly string[]): value is ChoiceBinding => bindingIssue(value, tabs) === undefined;

/** The tabs a binding names, as far as its options have the type. */
export const boundTabs = (value: unknown) => (isRecord(value) && arrayOf(isBound)(value.options) ? value.options.map((option) => option.tab) : []);

/** A stored `c:<id>:<ref>` record, or undefined. Its binding was checked against the view's tabs when it was stored. */
export function parseContext(value: unknown): ContextRecord | undefined {
	if (!isRecord(value) || value.v !== 1 || !isNat(value.expiresAt) || contextIssue(value.body) !== undefined || !isBody(value.body)) return undefined;
	const { choice } = value;
	const binding = choice === undefined ? undefined : isBinding(choice, boundTabs(choice)) ? choice : null;
	if (binding === null) return undefined;
	return { v: 1, expiresAt: value.expiresAt, body: value.body, ...(binding !== undefined ? { choice: binding } : {}) };
}

/** A stored `a:<id>:<ref>:<choice id>` record, or undefined. */
export function parseChoiceRecord(value: unknown): ChoiceRecord | undefined {
	if (!isRecord(value) || value.v !== 1 || !isNat(value.expiresAt) || !isNat(value.index) || !isUser(value.user) || !isNat(value.at)) return undefined;
	const { user } = value;
	return { v: 1, expiresAt: value.expiresAt, index: value.index, user: { id: user.id, ...(user.name !== undefined ? { name: user.name } : {}) }, at: value.at };
}

/** The upload of `PUT /api/view/<id>`: the view, the generation it commits, that generation's media and the expiry. */
export type ViewUpload = { generation: string; expiresAt: number; media: MediaEntry[]; view: StoredView };

/**
 * The upload in `value`, or why it is refused: `format` for a view format this host does not
 * accept, `shape` for anything else. `now` bounds the expiry to the next 365 days.
 */
export function parseUpload(value: unknown, now: number): { ok: true; upload: ViewUpload } | { ok: false; kind: 'format' | 'shape'; reason: string } {
	const shape = (reason: string) => ({ ok: false, kind: 'shape', reason }) as const;
	if (!isRecord(value)) return shape('the upload is { generation, expiresAt, media, view }');
	if (Object.keys(value).some((key) => key !== 'generation' && key !== 'expiresAt' && key !== 'media' && key !== 'view')) return shape('the upload is { generation, expiresAt, media, view }');
	const { generation, expiresAt, media, view } = value;
	if (!isString(generation) || !GENERATION.test(generation)) return shape('generation is 1 to 32 characters of [A-Za-z0-9_-]');
	if (!isNat(expiresAt) || expiresAt <= now || expiresAt > now + VIEW_LIMITS.ahead) return shape('expiresAt is a time in ms within the next 365 days');
	const issue = mediaIssue(media);
	if (issue !== undefined || !arrayOf(isMediaEntry)(media)) return shape(issue ?? 'media breaks its type');
	if (!isRecord(view)) return shape('the view is no JSON object');
	if (!VIEW_FORMATS.some((format) => format === view.v)) return { ok: false, kind: 'format', reason: `this host accepts the view formats ${VIEW_FORMATS.join(', ')}, and the view has ${JSON.stringify(view.v)}` };
	const viewProblem = viewIssue(view, media);
	if (viewProblem !== undefined || !isStoredView(view, media)) return shape(viewProblem ?? 'the view breaks its type');
	return { ok: true, upload: { generation, expiresAt, media, view } };
}

/** True for a view id and a ref of a path: the patterns of section 4.1 and 4.8. */
export const isViewId = (id: string) => VIEW_ID.test(id);
export const isRef = (ref: string) => REF.test(ref);

/** The labels of a stored view's tabs, in order. */
export const tabLabels = (view: StoredView) => view.tabs.map((tab) => tab.label);
