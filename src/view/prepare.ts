import { homedir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { isRecord, isString } from '../core/check.ts';
import type { PreparedView, Publishable, StoredContent, StoredView, Warning } from '../core/types.ts';
import { FileRefused, type FileRefusal, openPublishable, typeOf } from '../files/roots.ts';
import { htmlAttributes, type ImageRef, markdownImages } from './images.ts';
import { isMediaType, type MediaEntry, type MediaType, mediaIssue, sniff, VIEW_LIMITS, viewIssue } from './stored.ts';

export type ViewInput = { title?: string; tabs: TabInput[] };
export type TabInput = { label: string; content: ContentInput };
export type ContentInput =
	| { markdown: string; base?: string }
	| { diff: string }
	| { page: string; base?: string }
	| { gallery: { path: string; caption?: string }[] }
	| { file: string };

export type Prepared = { kind: 'ok'; prepared: PreparedView; files: { path: string; bytes: number }[]; warnings: Warning[] } | FileRefusal;

const refused = (reason: string): FileRefusal => ({ kind: 'refused', code: 'shape', reason });

const KINDS: Record<string, 'markdown' | 'diff' | 'page'> = { '.md': 'markdown', '.diff': 'diff', '.patch': 'diff', '.html': 'page' };

const SOURCES = new Set(['src', 'poster']);
const SOURCE_SET = 'srcset';
const EVENT_HANDLER = /<[a-z][^>]*\son[a-z]+\s*=/i;
const LINK = /<a\b[^>]*\bhref\s*=/i;

const isLocal = (ref: string) => ref !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith('//') && !ref.startsWith('#');
const isRemote = (ref: string) => /^(?:https?:)?\/\//i.test(ref);

function pathOf(ref: string): string {
	const bare = ref.split(/[?#]/)[0] ?? ref;
	try {
		return decodeURI(bare);
	} catch {
		return bare;
	}
}

function inputIssue(value: unknown): string | undefined {
	if (!isRecord(value) || Object.keys(value).some((key) => key !== 'title' && key !== 'tabs')) return 'a view is { title?, tabs }';
	if (value.title !== undefined && !isString(value.title)) return 'title is text';
	const { tabs } = value;
	const [least, most] = VIEW_LIMITS.tabs;
	if (!Array.isArray(tabs) || tabs.length < least || tabs.length > most) return `a view has ${least} to ${most} tabs`;
	const labels = new Set<string>();
	for (const tab of tabs) {
		if (!isRecord(tab) || Object.keys(tab).some((key) => key !== 'label' && key !== 'content') || !isString(tab.label)) return 'a tab is { label, content }';
		if (tab.label.length < 1 || tab.label.length > VIEW_LIMITS.label) return `a tab label has 1 to ${VIEW_LIMITS.label} characters: "${tab.label}"`;
		if (labels.has(tab.label)) return `the tab label "${tab.label}" is used twice`;
		labels.add(tab.label);
		const issue = contentIssue(tab.content);
		if (issue) return `tab "${tab.label}": ${issue}`;
	}
	return undefined;
}

function contentIssue(content: unknown): string | undefined {
	if (!isRecord(content)) return 'a content is one of markdown, diff, page, gallery and file';
	const keys = Object.keys(content);
	const only = (...allowed: string[]) => keys.every((key) => allowed.includes(key));
	const base = content.base === undefined || isString(content.base);
	if ('markdown' in content) return isString(content.markdown) && base && only('markdown', 'base') ? undefined : 'markdown is { markdown, base? } of text';
	if ('page' in content) return isString(content.page) && base && only('page', 'base') ? undefined : 'page is { page, base? } of text';
	if ('diff' in content) return isString(content.diff) && only('diff') ? undefined : 'diff is { diff } of text';
	if ('file' in content) return isString(content.file) && only('file') ? undefined : 'file is { file } with a path';
	if (!('gallery' in content) || !only('gallery') || !Array.isArray(content.gallery) || content.gallery.length === 0) return 'a content is one of markdown, diff, page, gallery and file';
	const item = (entry: unknown) => isRecord(entry) && isString(entry.path) && (entry.caption === undefined || isString(entry.caption)) && Object.keys(entry).every((key) => key === 'path' || key === 'caption');
	return content.gallery.every(item) ? undefined : 'a gallery is a list of { path, caption? }';
}

export async function prepareView(input: ViewInput, options: { roots: string[]; raw?: boolean }): Promise<Prepared> {
	const issue = inputIssue(input);
	if (issue !== undefined) return refused(issue);
	const cwd = process.cwd();
	const at = { roots: options.roots, cwd, home: homedir() };
	const opened: Publishable[] = [];
	const files: { path: string; bytes: number }[] = [];
	const media: { type: MediaType; bytes: Uint8Array }[] = [];
	const indexes = new Map<string, number>();
	const warnings: Warning[] = [];
	const warn = (code: Warning['code'], message: string) => {
		if (!warnings.some((warning) => warning.message === message)) warnings.push({ code, message });
	};

	async function read(path: string, limit: number): Promise<{ file: Publishable; bytes: Uint8Array } | FileRefusal> {
		const got = await openPublishable([path], at);
		if (got.kind === 'refused') return got;
		const [file] = got.files;
		if (!file) return refused(`cannot open ${path}`);
		opened.push(file);
		if (file.size > limit) return refused(`${path} has ${file.size} bytes, more than ${limit}`);
		try {
			return { file, bytes: await file.bytes() };
		} catch (error) {
			if (error instanceof FileRefused) return error.refusal;
			return refused(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function readText(path: string): Promise<{ text: string } | FileRefusal> {
		const got = await read(path, VIEW_LIMITS.viewBytes);
		if ('kind' in got) return got;
		files.push({ path: got.file.path, bytes: got.bytes.length });
		try {
			return { text: new TextDecoder('utf-8', { fatal: true }).decode(got.bytes) };
		} catch {
			return refused(`${path} is no UTF-8 text`);
		}
	}

	async function mediaOf(path: string): Promise<number | FileRefusal> {
		const known = indexes.get(path);
		if (known !== undefined) return known;
		const got = await read(path, VIEW_LIMITS.mediaBytes);
		if ('kind' in got) return got;
		const type = typeOf(path);
		if (!isMediaType(type)) return refused(`${path} is no png, jpg, jpeg, webp, gif or mp4 file`);
		const real = indexes.get(got.file.path);
		if (real !== undefined) {
			indexes.set(path, real);
			return real;
		}
		if (media.length >= VIEW_LIMITS.media) return refused(`a view has at most ${VIEW_LIMITS.media} media`);
		if (sniff(got.bytes) !== type) return refused(`${path} holds no ${type}`);
		media.push({ type, bytes: got.bytes });
		files.push({ path: got.file.path, bytes: got.bytes.length });
		const index = media.length - 1;
		indexes.set(path, index);
		indexes.set(got.file.path, index);
		return index;
	}

	const warnRemote = (ref: string) => {
		if (isRemote(ref)) warn('remote-image', `the image ${ref} is on another host: a view loads images from its own host alone, so it shows as text or not at all`);
	};

	async function resolveImages(text: string, base: string, refs: readonly ImageRef[]): Promise<{ text: string } | FileRefusal> {
		let out = '';
		let last = 0;
		for (const { start, end, ref } of refs) {
			warnRemote(ref);
			if (!isLocal(ref)) continue;
			const index = await mediaOf(resolve(base, pathOf(ref)));
			if (typeof index !== 'number') return index;
			out += `${text.slice(last, start)}"media:${index}"`;
			last = end;
		}
		return { text: out + text.slice(last) };
	}

	async function markdownOf(text: string, base: string): Promise<StoredContent | FileRefusal> {
		const map = new Map<string, number>();
		for (const ref of markdownImages(text)) {
			warnRemote(ref);
			if (!isLocal(ref)) continue;
			const index = await mediaOf(resolve(base, pathOf(ref)));
			if (typeof index !== 'number') return index;
			if (!media[index]?.type.startsWith('image/')) return refused(`the Markdown image ${ref} is a video: a Markdown tab shows png, jpg, jpeg, webp and gif images`);
			map.set(ref, index);
		}
		return map.size > 0 ? { markdown: text, media: Object.fromEntries(map) } : { markdown: text };
	}

	async function pageOf(text: string, base: string, label: string): Promise<{ text: string } | FileRefusal> {
		if (/<script/i.test(text)) return refused(`tab "${label}": a page may hold no <script`);
		if (EVENT_HANDLER.test(text)) warn('event-handler', `tab "${label}": a page runs no script, so its inline event handlers do nothing`);
		if (LINK.test(text)) warn('link', `tab "${label}": a page follows no link`);
		const attributes = htmlAttributes(text);
		for (const { name, value } of attributes.filter((attribute) => attribute.name === SOURCE_SET)) {
			const candidates = value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '');
			if (candidates.some(isLocal)) return refused(`tab "${label}": a page names its images in src or poster, and srcset="${value}" names local files`);
			for (const ref of candidates.filter(isRemote)) warn('remote-image', `the image ${ref} is on another host: a view loads images from its own host alone, so it shows as text or not at all`);
		}
		const refs = attributes.filter((attribute) => SOURCES.has(attribute.name)).map(({ start, end, value }) => ({ start, end, ref: value.trim() }));
		return resolveImages(text, base, refs);
	}

	const pageContent = (page: string): StoredContent => (options.raw ? { page, raw: true } : { page });

	async function contentOf(tab: TabInput): Promise<StoredContent | FileRefusal> {
		const { content, label } = tab;
		if ('file' in content) {
			const got = await readText(content.file);
			if ('kind' in got) return got;
			const kind = KINDS[extname(content.file).toLowerCase()];
			if (kind === undefined) return refused(`tab "${label}": ${content.file} ends in none of .md, .diff, .patch and .html`);
			const base = dirname(resolve(cwd, content.file));
			if (kind === 'diff') return { diff: got.text };
			if (kind === 'markdown') return markdownOf(got.text, base);
			const resolved = await pageOf(got.text, base, label);
			return 'kind' in resolved ? resolved : pageContent(resolved.text);
		}
		if ('markdown' in content) return markdownOf(content.markdown, resolve(cwd, content.base ?? '.'));
		if ('page' in content) {
			const resolved = await pageOf(content.page, resolve(cwd, content.base ?? '.'), label);
			return 'kind' in resolved ? resolved : pageContent(resolved.text);
		}
		if ('diff' in content) return { diff: content.diff };
		const gallery: { media: number; type: string; caption?: string }[] = [];
		for (const item of content.gallery) {
			const index = await mediaOf(resolve(cwd, item.path));
			if (typeof index !== 'number') return index;
			gallery.push({ media: index, type: media[index]?.type ?? '', ...(item.caption !== undefined ? { caption: item.caption } : {}) });
		}
		return { gallery };
	}

	try {
		const tabs: StoredView['tabs'] = [];
		for (const tab of input.tabs) {
			const content = await contentOf(tab);
			if ('kind' in content) return content;
			tabs.push({ label: tab.label, content });
		}
		const view: StoredView = { v: 1, ...(input.title !== undefined ? { title: input.title } : {}), tabs };
		const entries: MediaEntry[] = media.map(({ type, bytes }) => ({ type, size: bytes.length }));
		const problem = mediaIssue(entries) ?? viewIssue(view, entries);
		if (problem !== undefined) return refused(problem);
		return { kind: 'ok', prepared: { view, media }, files, warnings };
	} finally {
		await Promise.allSettled(opened.map((file) => file.close()));
	}
}
