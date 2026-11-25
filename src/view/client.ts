import { arrayOf, isInt, isNat, isRecord, isString } from '../core/check.ts';
import { isUser } from '../core/guards.ts';
import { viewUrl } from '../core/render.ts';
import { CHOICE_ID, REF, VIEW_ID } from '../core/shape.ts';
import type { Body, ChoiceBinding, HostRefusal, PreparedView, StoredChoice, ViewClient } from '../core/types.ts';

export const VIEW_TTL = { default: 7, most: 3650 } as const;
export const LATE_VIEW = { window: 10_000, pause: 500 } as const;
const DEADLINE = { request: 30_000, media: 120_000 } as const;
const DAY = 86_400_000;

export type ViewClientConfig = {
	origin: string;
	uploadKey: string;
	fetch?: (request: Request) => Promise<Response>;
	lateWindow?: number;
};

class NoAnswer extends Error {
	override name = 'NoAnswer';
}

const randomId = (count: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(count)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export const newViewId = () => randomId(16);

async function reasonOf(response: Response): Promise<string> {
	const text = await response.text().catch(() => '');
	try {
		const value: unknown = JSON.parse(text);
		if (isRecord(value) && isString(value.error)) return value.error;
	} catch {
	}
	return `the view host answered HTTP ${response.status}`;
}

function tabsOf(response: Response): string[] | undefined {
	try {
		const value: unknown = JSON.parse(decodeURIComponent(response.headers.get('View-Tabs') ?? ''));
		return Array.isArray(value) && value.every(isString) ? value : undefined;
	} catch {
		return undefined;
	}
}

function expiryOf(response: Response): number | undefined {
	const text = response.headers.get('View-Expires-At') ?? '';
	return /^\d{1,15}$/.test(text) ? Number(text) : undefined;
}

async function jsonOf(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

const isStoredChoice = (value: unknown): value is StoredChoice =>
	isRecord(value) &&
	isString(value.key) &&
	isString(value.view) &&
	VIEW_ID.test(value.view) &&
	isString(value.ref) &&
	REF.test(value.ref) &&
	isString(value.id) &&
	CHOICE_ID.test(value.id) &&
	isNat(value.index) &&
	isUser(value.user) &&
	isNat(value.at);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function viewClient(config: ViewClientConfig): ViewClient {
	const { origin, uploadKey } = config;
	if (!URL.canParse(origin) || !/^https?:$/.test(new URL(origin).protocol) || new URL(origin).origin !== origin) throw new TypeError(`the view host origin "${origin}" is no http or https origin`);
	const send = config.fetch ?? ((request: Request) => fetch(request));
	const lateWindow = config.lateWindow ?? LATE_VIEW.window;

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
			for (const [index, item] of prepared.media.entries()) {
				let response: Response;
				try {
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

		async context(id: string, ref: string, body: Body, choice?: ChoiceBinding) {
			const sent = JSON.stringify(choice ? { body, choice } : body);
			const response = await late(() => request('PUT', `${viewPath(id)}/context/${encodeURIComponent(ref)}`, { body: sent, type: 'application/json' }));
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
			const expiresAt = expiryOf(response);
			return tabs && expiresAt !== undefined ? { kind: 'present', tabs, expiresAt } : { kind: 'refused', reason: 'the view host named no tab labels or no expiry', status: response.status };
		},

		async version() {
			const response = await request('GET', '/api/version');
			if (!response.ok) return refusal(response);
			const value = await jsonOf(response);
			const formats = isRecord(value) && Array.isArray(value.formats) ? value.formats.filter((format) => isString(format) || isInt(format)).map(String) : undefined;
			return formats ? { kind: 'ok', formats } : { kind: 'refused', reason: 'the view host named no formats', status: response.status };
		},

		async choices() {
			const response = await request('GET', '/api/answers');
			if (!response.ok) return refusal(response);
			const value = await jsonOf(response);
			const choices = isRecord(value) && arrayOf(isStoredChoice)(value.choices) ? value.choices : undefined;
			return choices ? { kind: 'ok', choices } : { kind: 'refused', reason: 'the view host listed no choices', status: response.status };
		},

		async removeChoice(key: string) {
			const response = await request('DELETE', `/api/answer/${encodeURIComponent(key)}`);
			if (!response.ok) return refusal(response);
			await response.body?.cancel();
			return { kind: 'ok' };
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
