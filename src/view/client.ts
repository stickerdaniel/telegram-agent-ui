// `viewClient`: the client of a view host over the Fetch API, against the routes of handler.ts.
// `put` writes every media object under the view id and a new generation first, and the view
// object last, whose write commits the generation: a publish that fails midway leaves the
// earlier view readable and its own media to expire unread. A storage may show a new key late,
// so `context` and `has` ask again while the host answers 404, for up to 10 s.
import { isRecord, isString } from '../core/check.ts';
import { viewUrl } from '../core/render.ts';
import { VIEW_ID } from '../core/shape.ts';
import type { Body, HostRefusal, PreparedView, ViewClient } from '../core/types.ts';

/** How long a view lives by default and at most, in days. */
export const VIEW_TTL = { default: 7, most: 365 } as const;
/** How long `context` and `has` ask again while the host answers 404, and the pause between two asks, in ms. */
export const LATE_VIEW = { window: 10_000, pause: 500 } as const;
// A request without an answer after this long counts as one without an answer: a media upload
// carries up to 20 MiB, any other request a view of 2 MiB or less.
const DEADLINE = { request: 30_000, media: 120_000 } as const;
const DAY = 86_400_000;

/** The configuration of a client. `fetch` replaces the global one, such as a handler called in the same process. */
export type ViewClientConfig = {
	/** The host's origin, such as `https://views.example.com`. */
	origin: string;
	/** The bearer secret of every upload route. */
	uploadKey: string;
	fetch?: (request: Request) => Promise<Response>;
	/** How long a 404 of `context` and `has` is asked again, in ms: 10 s by default, 0 for a storage that shows every key at once. */
	lateWindow?: number;
};

/** A request that got no answer, or an answer of 5xx: it may have reached the host. */
class NoAnswer extends Error {
	override name = 'NoAnswer';
}

/** `count` random bytes as base64url. */
const randomId = (count: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(count)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** A new view id: 128 random bits as 22 base64url characters. */
export const newViewId = () => randomId(16);

/** The reason a host gave for a refusal: the `error` of its JSON, else the status. */
async function reasonOf(response: Response): Promise<string> {
	const text = await response.text().catch(() => '');
	try {
		const value: unknown = JSON.parse(text);
		if (isRecord(value) && isString(value.error)) return value.error;
	} catch {
		// No JSON: the status names the refusal.
	}
	return `the view host answered HTTP ${response.status}`;
}

/** The tab labels of a HEAD answer, or undefined when its header breaks its format. */
function tabsOf(response: Response): string[] | undefined {
	try {
		const value: unknown = JSON.parse(decodeURIComponent(response.headers.get('View-Tabs') ?? ''));
		return Array.isArray(value) && value.every(isString) ? value : undefined;
	} catch {
		return undefined;
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A client of the view host at `origin` with its upload key. Throws TypeError for an origin
 * that is no http or https origin.
 *
 * - `put` publishes a prepared view under `options.id`, or a new id of 128 random bits, for
 *   `ttlDays` days (7 by default, at most 365). Repeating it with the same id is safe: the last
 *   write that completes wins. `uncertain` means the view object may have been stored: put it
 *   again with that id.
 * - `context` stores a question's body under the view and its ref. `missing` means the view is
 *   not on the host after the late window.
 * - `has` returns the view's tab labels. `delete` removes the view and its media.
 *
 * `context`, `has` and `delete` reject when the host gives no answer or answers 5xx.
 *
 *   const views = viewClient({ origin: 'https://views.example.com', uploadKey });
 *   const put = await views.put(prepared, { ttlDays: 3 });
 *   if (put.kind === 'ok') await views.context(put.id, 'merge1', { markdown: 'Merge now?' });
 */
export function viewClient(config: ViewClientConfig): ViewClient {
	const { origin, uploadKey } = config;
	if (!URL.canParse(origin) || !/^https?:$/.test(new URL(origin).protocol) || new URL(origin).origin !== origin) throw new TypeError(`the view host origin "${origin}" is no http or https origin`);
	const send = config.fetch ?? ((request: Request) => fetch(request));
	const lateWindow = config.lateWindow ?? LATE_VIEW.window;

	/** One request with the upload key. Rejects with NoAnswer when nothing came back in time, or a 5xx did. */
	async function request(method: string, path: string, init: { body?: Uint8Array<ArrayBuffer> | string; type?: string; deadline?: number } = {}): Promise<Response> {
		const headers: Record<string, string> = { Authorization: `Bearer ${uploadKey}` };
		if (init.type !== undefined) headers['Content-Type'] = init.type;
		let response: Response;
		try {
			response = await send(new Request(`${origin}${path}`, { method, headers, ...(init.body !== undefined ? { body: init.body } : {}), signal: AbortSignal.timeout(init.deadline ?? DEADLINE.request) }));
		} catch (error) {
			throw new NoAnswer(`${method} ${path} got no answer from the view host: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (response.status >= 500) throw new NoAnswer(`${method} ${path}: ${await reasonOf(response)}`);
		return response;
	}

	const refusal = async (response: Response): Promise<HostRefusal> => ({ kind: 'refused', reason: await reasonOf(response), status: response.status });

	/** `attempt` again while it answers 404, until the late window passed. */
	async function late(attempt: () => Promise<Response>): Promise<Response> {
		const until = Date.now() + lateWindow;
		for (;;) {
			const response = await attempt();
			if (response.status !== 404 || Date.now() + LATE_VIEW.pause > until) return response;
			await response.body?.cancel();
			await sleep(LATE_VIEW.pause);
		}
	}

	const viewPath = (id: string) => `/api/view/${encodeURIComponent(id)}`;

	return {
		async put(prepared: PreparedView, options = {}) {
			const id = options.id ?? newViewId();
			if (!VIEW_ID.test(id)) return { kind: 'refused', reason: `the view id "${id}" is not 22 base64url characters` };
			const ttl = options.ttlDays ?? VIEW_TTL.default;
			if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > VIEW_TTL.most) return { kind: 'refused', reason: `a view lives 1 to ${VIEW_TTL.most} days, not ${ttl}` };
			const expiresAt = Date.now() + ttl * DAY;
			const generation = randomId(12);
			// The media first: the view object commits them, so a failure here changes no view.
			for (const [index, item] of prepared.media.entries()) {
				let response: Response;
				try {
					// A copy on an ArrayBuffer of its own: what every runtime's fetch takes as a body.
					response = await request('PUT', `/api/media/${id}/${generation}/${index}?e=${expiresAt}`, { body: new Uint8Array(item.bytes), type: item.type, deadline: DEADLINE.media });
				} catch (error) {
					return { kind: 'refused', reason: `${error instanceof Error ? error.message : String(error)}. No view changed` };
				}
				if (!response.ok) return refusal(response);
				await response.body?.cancel();
			}
			const media = prepared.media.map((item) => ({ type: item.type, size: item.bytes.length }));
			let response: Response;
			try {
				response = await request('PUT', viewPath(id), { body: JSON.stringify({ generation, expiresAt, media, view: prepared.view }), type: 'application/json' });
			} catch (error) {
				return { kind: 'uncertain', id, reason: error instanceof Error ? error.message : String(error) };
			}
			if (!response.ok) return refusal(response);
			await response.body?.cancel();
			return { kind: 'ok', id, url: viewUrl({ id, origin }), expiresAt };
		},

		async context(id: string, ref: string, body: Body) {
			const response = await late(() => request('PUT', `${viewPath(id)}/context/${encodeURIComponent(ref)}`, { body: JSON.stringify(body), type: 'application/json' }));
			if (response.status === 404) return { kind: 'missing' };
			if (!response.ok) return refusal(response);
			await response.body?.cancel();
			return { kind: 'ok' };
		},

		async has(id: string) {
			const response = await late(() => request('HEAD', viewPath(id)));
			if (response.status === 404) return { kind: 'missing' };
			if (!response.ok) return { kind: 'refused', reason: `the view host answered HTTP ${response.status}`, status: response.status };
			const tabs = tabsOf(response);
			return tabs ? { kind: 'present', tabs } : { kind: 'refused', reason: 'the view host named no tab labels', status: response.status };
		},

		async delete(id: string) {
			const response = await request('DELETE', viewPath(id));
			if (response.status === 404) return { kind: 'missing' };
			if (!response.ok) return refusal(response);
			await response.body?.cancel();
			return { kind: 'ok' };
		},
	};
}
