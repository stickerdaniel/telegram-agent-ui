// The Cloudflare entry: the view handler on one KV namespace. `view deploy` fills wrangler.toml
// beside this file and deploys it: the binding VIEWS, the variables BOT_ID, ALLOWED_USERS,
// LABELS and THEME (the last three as JSON) and the secrets UPLOAD_KEY and MEDIA_KEY. A value's
// type rides in its KV metadata, and an expiry becomes KV's `expiration` in seconds, at least
// the 60 s ahead that KV demands. A list reads every page of KV's listing, 1,000 keys each, and
// may miss a key written in the last 60 s. A variable that breaks its format answers every
// request with 500 and the reason. workerd takes every value this module exports as an
// entrypoint, so it exports the handler alone.
import { arrayOf, isInt, isRecord, isString } from '../core/check.ts';
import { parseLabels } from '../core/labels.ts';
import { createViewHandler, parseTheme, type ViewStorage } from '../view/handler.ts';

/** The part of a Workers KV binding the host uses. */
type Kv = {
	getWithMetadata(key: string, type: 'arrayBuffer'): Promise<{ value: ArrayBuffer | null; metadata: unknown }>;
	put(key: string, value: Uint8Array, options: { expiration: number; metadata?: { type: string } }): Promise<void>;
	delete(key: string): Promise<void>;
	list(options: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
};

export type Env = { VIEWS: Kv; BOT_ID: string; ALLOWED_USERS: string; UPLOAD_KEY: string; MEDIA_KEY: string; LABELS?: string; THEME?: string; PUBLIC_KEY?: string };

const kvStorage = (kv: Kv): ViewStorage => ({
	async get(key) {
		const { value, metadata } = await kv.getWithMetadata(key, 'arrayBuffer');
		if (value === null) return undefined;
		const type = isRecord(metadata) && isString(metadata.type) ? metadata.type : undefined;
		return { value: new Uint8Array(value), ...(type !== undefined ? { type } : {}) };
	},
	put: (key, value, { expiresAt, type }) => kv.put(key, value, { expiration: Math.max(Math.ceil(expiresAt / 1000), Math.ceil(Date.now() / 1000) + 60), ...(type !== undefined ? { metadata: { type } } : {}) }),
	delete: (key) => kv.delete(key),
	async list(prefix) {
		const names: string[] = [];
		let cursor: string | undefined;
		for (;;) {
			const page = await kv.list({ prefix, ...(cursor !== undefined ? { cursor } : {}) });
			names.push(...page.keys.map((key) => key.name));
			if (page.list_complete || page.cursor === undefined) return names;
			cursor = page.cursor;
		}
	},
});

/** A JSON variable read by `parse`, or a thrown TypeError that names it. Empty or unset reads as `fallback`. */
function variable<T>(env: Env, name: 'ALLOWED_USERS' | 'LABELS' | 'THEME', parse: (value: unknown) => T | undefined, fallback?: T): T | undefined {
	const text = env[name];
	if (!text) return fallback;
	const value = parse(JSON.parse(text));
	if (value === undefined) throw new TypeError(`${name} breaks its format`);
	return value;
}

function handlerOf(env: Env) {
	const theme = variable(env, 'THEME', parseTheme);
	return createViewHandler({
		storage: kvStorage(env.VIEWS),
		botId: env.BOT_ID,
		allowedUsers: variable(env, 'ALLOWED_USERS', (value) => (arrayOf(isInt)(value) ? value : undefined), []) ?? [],
		uploadKey: env.UPLOAD_KEY ?? '',
		mediaKey: env.MEDIA_KEY ?? '',
		labels: variable(env, 'LABELS', parseLabels, {}) ?? {},
		...(theme ? { theme } : {}),
		...(env.PUBLIC_KEY ? { publicKey: env.PUBLIC_KEY } : {}),
	});
}

let built: { env: Env; handle: (request: Request) => Promise<Response> } | undefined;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			if (built?.env !== env) built = { env, handle: handlerOf(env) };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return new Response(`the view host is misconfigured: ${reason}`, {
				status: 500,
				headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
			});
		}
		return built.handle(request);
	},
};
