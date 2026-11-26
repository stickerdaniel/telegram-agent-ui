import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { type Browser, type BrowserContext, type BrowserContextOptions, chromium, type Frame, type Page, webkit } from 'playwright-core';
import type { StoredContent } from '../core/types.ts';
import { BOT, ID, launchKey, MEDIA, MEDIA_KEY, memoryStorage, ORIGIN, UPLOAD_KEY, USER } from './fixtures.ts';
import { createViewHandler } from './handler.ts';

setDefaultTimeout(30_000);

const { hex, launch } = await launchKey();
const CLIP = `data:video/mp4;base64,${readFileSync(new URL('./testdata/clip.mp4', import.meta.url)).toString('base64')}`;
const DEVICES = {
	desktop: { viewport: { width: 1100, height: 720 } },
	phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
} satisfies Record<string, BrowserContextOptions>;
type Device = keyof typeof DEVICES;
type Tab = { label: string; content: StoredContent };
type Options = { device?: Device; reducedMotion?: 'reduce'; wanted?: string; answer?: unknown; delayMedia?: number; media?: { type: string; bytes: Uint8Array<ArrayBuffer> }[]; question?: string; late?: boolean; query?: [string, string][] };

const page = (html: string): StoredContent => ({ page: html });
const STYLE = '<style>html, body { margin: 0; } p, a, button, div { display: block; width: 100%; height: 40px; margin: 0; padding: 0; border: 0; }</style>';
const stacked = (heights: number[]): Tab[] =>
	heights.map((height, i) => ({
		label: 'ABC'[i] ?? '',
		content: page(
			`${STYLE}<h1 style="margin: 0; height: 60px">${'ABC'[i]}</h1><a id="link" href="javascript:void(0)">Link</a><button id="button">Knopf</button><div id="pointer" style="cursor: pointer">Zeiger</div><p id="plain">Text</p><div id="spin" role="spinbutton">5</div><div id="quiet" tabindex="-1">Fokus</div><div id="host" role="button" tabindex="0"><template shadowrootmode="open"><span id="inner" style="display: block; height: 40px">Schatten</span></template></div><div style="height: ${height}px"></div>`,
		),
	}));
const contained = (html: (inner: string) => string): Tab[] => [3000, 1500].map((height, i) => ({ label: 'AB'[i] ?? '', content: page(html(`<h1 style="margin: 0">${'AB'[i]}</h1><div style="height: ${height}px"></div>`)) }));
const FULL_HEIGHT = (inner: string) => `<style>html, body { margin: 0; height: 100%; overflow: hidden; }</style><main id="main" style="height: 100%; overflow: auto">${inner}</main>`;

const telegramStub = (initData: string) => `
window.opened = [];
window.tgHandlers = {};
sessionStorage.setItem('__telegram__initParams', JSON.stringify({ tgWebAppData: ${JSON.stringify(initData)} }));
window.Telegram = { WebApp: {
	initData: ${JSON.stringify(initData)}, colorScheme: 'light',
	ready() {}, expand() {}, disableVerticalSwipes() {}, close() {},
	openLink(url) { opened.push(url); }, openTelegramLink(url) { opened.push(url); },
	onEvent(name, handler) { tgHandlers[name] = handler; },
	MainButton: { setText() {}, onClick() {}, show() {}, hide() {}, enable() {}, disable() {} },
} };`;

for (const engine of [chromium, webkit])
	describe(engine.name(), () => {
		let browser: Browser;
		let context: BrowserContext | undefined;
		beforeAll(async () => {
			browser = await engine.launch();
		}, 60_000);
		afterEach(async () => {
			await context?.close();
			context = undefined;
		}, 30_000);
		afterAll(async () => {
			await browser?.close();
		}, 60_000);

		async function open(tabs: Tab[], opts: Options = {}) {
			const memory = memoryStorage();
			const handle = createViewHandler({ storage: memory.storage, botId: BOT, allowedUsers: [USER], uploadKey: UPLOAD_KEY, mediaKey: MEDIA_KEY, publicKey: hex });
			const expiresAt = Date.now() + 86_400_000;
			const upload = (target: string, body: string | Uint8Array<ArrayBuffer>, type = 'application/json') =>
				handle(new Request(`${ORIGIN}${target}`, { method: 'PUT', headers: { Authorization: `Bearer ${UPLOAD_KEY}`, 'Content-Type': type }, body }));
			const media = opts.media ?? [];
			for (const [index, { type, bytes }] of media.entries()) expect((await upload(`/api/media/${ID}/g1/${index}?e=${expiresAt}`, bytes, type)).status).toBe(200);
			const stored = { generation: 'g1', expiresAt, media: media.map(({ type, bytes }) => ({ type, size: bytes.byteLength })), view: { v: 1, tabs } };
			expect((await upload(`/api/view/${ID}`, JSON.stringify(stored))).status).toBe(200);
			const ask = () => upload(`/api/view/${ID}/context/ask1`, JSON.stringify({ markdown: opts.question }));
			if (opts.question !== undefined && !opts.late) expect((await ask()).status).toBe(200);
			context = await browser.newContext({ ...DEVICES[opts.device ?? 'desktop'], ...(opts.reducedMotion ? { reducedMotion: opts.reducedMotion } : {}) });
			context.setDefaultTimeout(5000);
			const initData = await launch();
			const requests: string[] = [];
			await context.route('**/*', async (route) => {
				const request = route.request();
				const url = new URL(request.url());
				requests.push(url.href);
				if (url.href === 'https://telegram.org/js/telegram-web-app.js') return route.fulfill({ contentType: 'text/javascript', body: telegramStub(initData) });
				if (url.href === 'https://telegram.org/probe.js') return route.fulfill({ contentType: 'text/javascript', body: "document.documentElement.dataset.probe = 'ran';" });
				if (url.origin !== ORIGIN) return route.abort();
				if (opts.answer !== undefined && url.pathname === '/api/view') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.answer) });
				if (opts.delayMedia && url.pathname.startsWith('/m/')) await new Promise((resolve) => setTimeout(resolve, opts.delayMedia));
				const sent = request.method() === 'GET' || request.method() === 'HEAD' ? null : request.postDataBuffer();
				const body = sent ? new Uint8Array(sent) : undefined;
				const response = await handle(new Request(url, { method: request.method(), headers: await request.allHeaders(), ...(body ? { body } : {}) }));
				return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
			});
			const tab = await context.newPage();
			const search = new URLSearchParams({ v: ID, ...(opts.wanted ? { t: opts.wanted } : {}), ...(opts.question !== undefined ? { q: 'ask1' } : {}) });
			for (const [name, value] of opts.query ?? []) search.append(name, value);
			await tab.goto(`${ORIGIN}/?${search}#tgWebAppData=${encodeURIComponent(initData)}`, { waitUntil: 'domcontentloaded' });
			await tab.locator('#panels').waitFor();
			if (opts.question !== undefined && opts.late) expect((await ask()).status).toBe(200);
			return { page: tab, requests };
		}

		const frameSelector = (index: number) => `#panels > section:nth-child(${index + 1}) iframe`;
		const position = (tab: Page) => tab.locator('#panels').evaluate((strip: HTMLElement) => Math.round(strip.scrollLeft / strip.clientWidth));
		async function preview(tab: Page, index?: number): Promise<Frame> {
			const handle = await tab.locator(frameSelector(index ?? (await position(tab)))).elementHandle();
			const frame = await handle?.contentFrame();
			if (!frame) throw new Error('page frame missing');
			await frame.waitForSelector('h1', { state: 'attached' });
			return frame;
		}
		async function drain(tab: Page) {
			await tab.evaluate(
				() =>
					new Promise<void>((resolve) => {
						const done = (event: MessageEvent) => {
							if (event.source !== window || event.data !== 'test-barrier') return;
							window.removeEventListener('message', done);
							resolve();
						};
						window.addEventListener('message', done);
						window.postMessage('test-barrier', '*');
					}),
			);
		}
		async function selected(tab: Page, label: string) {
			await tab.waitForFunction((label) => {
				const tabs = [...document.querySelectorAll('#tabs [role="tab"]')];
				const index = tabs.findIndex((button) => button.textContent === label);
				const strip = document.getElementById('panels');
				return index >= 0 && strip !== null && tabs.every((button, i) => button.getAttribute('aria-selected') === String(i === index)) && Math.abs(strip.scrollLeft - index * strip.clientWidth) < 2;
			}, label);
		}
		async function settled(tab: Page, label: string) {
			await selected(tab, label);
			await tab.locator('#panels').evaluate(
				(strip: HTMLElement) =>
					new Promise<void>((resolve) => {
						let last = strip.scrollLeft;
						let since = Date.now();
						const check = () => {
							if (strip.scrollLeft !== last) [last, since] = [strip.scrollLeft, Date.now()];
							if (Date.now() - since >= 400) resolve();
							else setTimeout(check, 30);
						};
						check();
					}),
			);
			await selected(tab, label);
		}
		const trackPages = (tab: Page) =>
			tab.locator('#panels').evaluate((strip: HTMLElement) => {
				const seen: number[] = [];
				Reflect.set(window, 'seen', seen);
				strip.addEventListener('scroll', () => seen.push(Math.round((strip.scrollLeft / strip.clientWidth) * 100) / 100));
			});
		async function passed(tab: Page) {
			const trace = await tab.waitForFunction(() => {
				const seen: unknown = Reflect.get(window, 'seen');
				const strip = document.getElementById('panels');
				return Array.isArray(seen) && strip !== null && seen.at(-1) === Math.round((strip.scrollLeft / strip.clientWidth) * 100) / 100 && seen;
			});
			return ((await trace.jsonValue()) as number[]).filter((value, i, all) => value !== all[i - 1]);
		}
		async function tapPage(tab: Page, x: number, id: string, touch: boolean) {
			const frame = await tab.locator(frameSelector(await position(tab))).boundingBox();
			const target = await (await preview(tab)).locator(`#${id}`).boundingBox();
			if (!frame || !target) throw new Error('page missing');
			const point = { x: frame.x + frame.width * x, y: target.y + target.height / 2 };
			if (touch) await tab.touchscreen.tap(point.x, point.y);
			else await tab.mouse.click(point.x, point.y);
			await drain(tab);
		}
		const share = (tab: Page, index: number, id?: string) =>
			preview(tab, index).then((frame) =>
				frame.evaluate((id) => {
					const scroller = id ? document.getElementById(id) : document.scrollingElement;
					if (!scroller) throw new Error('scroller missing');
					return Math.round((scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight)) * 100) / 100;
				}, id),
			);
		async function scrollIn(tab: Page, index: number, top: number, id?: string) {
			await (await preview(tab, index)).evaluate(
				([top, id]) =>
					new Promise((resolve) => {
						const scroller = id ? document.getElementById(id) : document.scrollingElement;
						scroller?.scrollTo(0, top);
						setTimeout(resolve, 100);
					}),
				[top, id] as const,
			);
			await drain(tab);
		}
		async function scrollToShare(tab: Page, index: number, ratio: number) {
			await (await preview(tab, index)).evaluate(
				(ratio) =>
					new Promise((resolve) => {
						const root = document.scrollingElement;
						if (root) root.scrollTo(0, (root.scrollHeight - root.clientHeight) * ratio);
						setTimeout(resolve, 100);
					}),
				ratio,
			);
			await drain(tab);
		}

		test.each([
			['phone', true],
			['desktop', false],
		] as const)('on a %s a tap in the outer quarter of the page jumps to the next tab at once, wrapping', async (device, touch) => {
			const { page: tab } = await open(stacked([2000, 2000, 2000]), { device });
			await preview(tab, 0);
			await trackPages(tab);
			for (const label of ['B', 'C', 'A']) {
				await tapPage(tab, 0.9, 'plain', touch);
				await selected(tab, label);
			}
			await tapPage(tab, 0.1, 'plain', touch);
			await settled(tab, 'C');
			expect(await passed(tab)).toEqual([1, 2, 0, 2]);
		});

		test('a tap in the middle of the page, on a link, a button, a pointer cursor, a spin button, tabindex -1 or a shadow tree keeps the tab', async () => {
			const { page: tab } = await open(stacked([2000, 2000, 2000]), { device: 'phone' });
			await preview(tab, 0);
			await tapPage(tab, 0.5, 'plain', true);
			await settled(tab, 'A');
			for (const id of ['link', 'button', 'pointer', 'spin', 'quiet', 'inner']) {
				await tapPage(tab, 0.9, id, true);
				await settled(tab, 'A');
			}
		});

		test('a drag back to its start and a click that clears a selection keep the tab, and the same click then jumps', async () => {
			const { page: tab } = await open(stacked([2000, 2000, 2000]));
			const frame = await tab.locator(frameSelector(0)).boundingBox();
			const plain = await (await preview(tab, 0)).locator('#plain').boundingBox();
			if (!frame || !plain) throw new Error('page missing');
			const [x, y] = [frame.x + frame.width * 0.9, plain.y + plain.height / 2];
			await tab.mouse.move(x, y);
			await tab.mouse.down();
			await tab.mouse.move(x - 80, y, { steps: 5 });
			await tab.mouse.move(x, y, { steps: 5 });
			await tab.mouse.up();
			await drain(tab);
			await settled(tab, 'A');
			await (await preview(tab, 0)).evaluate(() => getSelection()?.selectAllChildren(document.querySelector('h1') ?? document.body));
			await tab.mouse.click(x, y);
			await drain(tab);
			await settled(tab, 'A');
			await tab.mouse.click(x, y);
			await selected(tab, 'B');
		});

		test('a pill, a key and a tap jump to their tab without passing the tabs between', async () => {
			const tabs: Tab[] = ['A', 'B', 'C', 'D'].map((label) => ({ label, content: page(`${STYLE}<h1>${label}</h1><p id="plain">Text</p>`) }));
			const { page: tab } = await open(tabs);
			await preview(tab, 0);
			await trackPages(tab);
			await tab.getByRole('tab', { name: 'D', exact: true }).click();
			await settled(tab, 'D');
			await tab.keyboard.press('ArrowRight');
			await settled(tab, 'A');
			await tab.keyboard.press('ArrowLeft');
			await settled(tab, 'D');
			await tapPage(tab, 0.9, 'plain', false);
			await settled(tab, 'A');
			expect(await passed(tab)).toEqual([3, 0, 3, 0]);
		});

		test('every page follows the share of the shown page, on pages of other heights, and a hidden page moves none', async () => {
			const { page: tab } = await open(stacked([3000, 1500, 6000]), { device: 'phone' });
			await preview(tab, 0);
			await scrollToShare(tab, 0, 0.4);
			expect([await share(tab, 1), await share(tab, 2)]).toEqual([0.4, 0.4]);
			await tab.getByRole('tab', { name: 'B', exact: true }).click();
			await settled(tab, 'B');
			expect(await share(tab, 1)).toBe(0.4);
			await tab.getByRole('tab', { name: 'C', exact: true }).click();
			await settled(tab, 'C');
			expect(await share(tab, 2)).toBe(0.4);
			await scrollIn(tab, 2, 0);
			await scrollIn(tab, 0, 500);
			expect(await share(tab, 0)).toBeGreaterThan(0);
			expect([await share(tab, 1), await share(tab, 2)]).toEqual([0, 0]);
		});

		test('a resize that changes the scroll range of the shown page moves the others to its new share', async () => {
			const { page: tab } = await open(stacked([1500, 1500]), { device: 'phone' });
			await preview(tab, 0);
			await scrollIn(tab, 0, 600);
			const before = await share(tab, 0);
			await tab.setViewportSize({ width: 390, height: 500 });
			await new Promise((resolve) => setTimeout(resolve, 300));
			await drain(tab);
			const after = await share(tab, 0);
			expect(Math.abs(after - before)).toBeGreaterThan(0.05);
			await tab.getByRole('tab', { name: 'B', exact: true }).click();
			await settled(tab, 'B');
			expect(Math.abs((await share(tab, 1)) - after)).toBeLessThanOrEqual(0.01);
		});

		test('a page whose main scroll area is a full-height container keeps its share across tabs', async () => {
			const { page: tab } = await open(contained(FULL_HEIGHT), { device: 'phone' });
			await preview(tab, 0);
			await scrollIn(tab, 0, 740, 'main');
			const first = await share(tab, 0, 'main');
			expect(first).toBeGreaterThan(0.2);
			await tab.getByRole('tab', { name: 'B', exact: true }).click();
			await settled(tab, 'B');
			expect(Math.abs((await share(tab, 1, 'main')) - first)).toBeLessThanOrEqual(0.01);
		});

		test.each([
			['hidden', 'visibility: hidden'],
			['nearly off-screen', 'transform: translateX(99%)'],
		])('a %s full-screen drawer does not take the share from the visible main scroll area', async (_, style) => {
			const drawer = (inner: string) =>
				`<style>html, body { margin: 0; height: 100%; overflow: hidden; }</style><header style="height: 48px">Kopf</header><main id="main" style="height: calc(100% - 48px); overflow: auto">${inner}</main><aside style="position: fixed; inset: 0; overflow: auto; ${style}"><div style="height: 5000px"></div></aside>`;
			const { page: tab } = await open(contained(drawer), { device: 'phone' });
			await preview(tab, 0);
			await scrollIn(tab, 0, 740, 'main');
			const first = await share(tab, 0, 'main');
			expect(first).toBeGreaterThan(0.2);
			await tab.getByRole('tab', { name: 'B', exact: true }).click();
			await settled(tab, 'B');
			expect(Math.abs((await share(tab, 1, 'main')) - first)).toBeLessThanOrEqual(0.01);
		});

		test('opening a details element in a full-height container moves the others to its new share', async () => {
			const opener = (inner: string) => FULL_HEIGHT(`<div style="height: 600px"></div><details><summary>Mehr</summary><div style="height: 2000px"></div></details>${inner}`);
			const { page: tab } = await open(contained(opener), { device: 'phone' });
			const frame = await preview(tab, 0);
			await scrollIn(tab, 0, 500, 'main');
			const before = await share(tab, 0, 'main');
			await frame.locator('summary').click();
			await new Promise((resolve) => setTimeout(resolve, 100));
			await drain(tab);
			const after = await share(tab, 0, 'main');
			expect(before - after).toBeGreaterThan(0.05);
			await tab.getByRole('tab', { name: 'B', exact: true }).click();
			await settled(tab, 'B');
			expect(Math.abs((await share(tab, 1, 'main')) - after)).toBeLessThanOrEqual(0.01);
		});

		test('left and right move from the shell and from a page, wrapping, and stay in a text field', async () => {
			const tabs: Tab[] = ['A', 'B', 'C'].map((label) => ({ label, content: page(`<h1 tabindex="0">${label}</h1><input id="field" value="abcd">`) }));
			const { page: tab } = await open(tabs);
			await preview(tab, 0);
			await tab.keyboard.press('ArrowLeft');
			await selected(tab, 'C');
			await (await preview(tab, 2)).locator('h1').click();
			await tab.keyboard.press('ArrowRight');
			await selected(tab, 'A');
			await (await preview(tab, 0)).locator('#field').click();
			await tab.keyboard.press('ArrowRight');
			await drain(tab);
			await settled(tab, 'A');
		});

		test('left and right at either end of an email or a number field keep the tab, and inside the field they move the caret', async () => {
			const tabs: Tab[] = ['A', 'B', 'C'].map((label) => ({ label, content: page(`<h1>${label}</h1><input id="mail" type="email" value="ab@c.de"><input id="count" type="number" value="1234">`) }));
			const { page: tab } = await open(tabs);
			await tab.getByRole('tab', { name: 'B', exact: true }).click();
			await settled(tab, 'B');
			const frame = await preview(tab, 1);
			for (const field of ['#mail', '#count'])
				for (const key of ['ArrowLeft', 'ArrowRight']) {
					await frame.locator(field).click();
					for (let press = 0; press < 9; press++) await tab.keyboard.press(key);
					await drain(tab);
					await settled(tab, 'B');
				}
			await frame.locator('#mail').click();
			for (let press = 0; press < 9; press++) await tab.keyboard.press('ArrowLeft');
			await tab.keyboard.press('ArrowRight');
			await tab.keyboard.type('X');
			expect(await frame.locator('#mail').inputValue()).toBe('aXb@c.de');
			await frame.locator('#count').click();
			for (let press = 0; press < 9; press++) await tab.keyboard.press('ArrowLeft');
			await tab.keyboard.press('ArrowRight');
			await tab.keyboard.type('9');
			expect(await frame.locator('#count').inputValue()).toBe('19234');
		});

		test('a wheel right after an arrow in a field changes the tab, again on the same page, after a pick of another page and on a Markdown tab', async () => {
			const tabs: Tab[] = [
				...['A', 'B', 'C'].map((label) => ({ label, content: page(`<h1>${label}</h1><input id="mail" type="email" value="ab@c.de">`) })),
				{ label: 'Notes', content: { markdown: '# Notes' } },
			];
			const { page: tab } = await open(tabs);
			await tab.evaluate(() => {
				const frozen = performance.now();
				Object.defineProperty(performance, 'now', { value: () => frozen, configurable: true });
			});
			const box = await tab.locator('#panels').boundingBox();
			if (!box) throw new Error('strip missing');
			const pill = (label: string) => tab.getByRole('tab', { name: label, exact: true });
			const painted = () => tab.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			const picked = (label: string) => async () => {
				await pill(label).click();
				await selected(tab, label);
			};
			const armed = async (index: number, between: () => Promise<void>, dx: number) => {
				await (await preview(tab, index)).locator('#mail').click();
				await tab.keyboard.press('ArrowRight');
				await between();
				await painted();
				await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				await tab.mouse.wheel(dx * box.width * 0.6, 0);
			};
			await armed(0, async () => {}, 1);
			await settled(tab, 'B');
			await pill('A').click();
			await settled(tab, 'A');
			await armed(0, async () => {}, 1);
			await settled(tab, 'B');
			await pill('A').click();
			await settled(tab, 'A');
			await armed(0, picked('B'), 1);
			await settled(tab, 'C');
			await armed(2, picked('Notes'), -1);
			await settled(tab, 'C');
		});

		const LONG = `Which **one**? ${'The page keeps the swipe and the keys while the question is open. '.repeat(6)}`;
		const folded = (tab: Page) =>
			tab.evaluate(() => {
				const fold = document.querySelector('#question .fold');
				const button = document.getElementById('ask');
				return {
					expanded: button?.getAttribute('aria-expanded'),
					button: button ? getComputedStyle(button).display !== 'none' : null,
					height: fold ? Math.round(fold.getBoundingClientRect().height - parseFloat(getComputedStyle(fold).paddingTop)) : null,
				};
			});
		const CLOSED = { expanded: 'false', button: true, height: 44 };
		const settle = (tab: Page) => tab.waitForFunction(() => document.querySelector('#question .fold')?.getAnimations().length === 0);
		const frameHeight = (tab: Page) => tab.locator(frameSelector(0)).evaluate((frame: HTMLElement) => frame.getBoundingClientRect().height);

		test('a question shows two lines above the pill row, flowing under the chevron, slides open on a tap and pushes the page down by its height, and a second tap closes it', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { device: 'phone', question: LONG });
			await preview(tab, 0);
			expect(await tab.locator('#view > *').evaluateAll((nodes) => nodes.map((node) => node.id || node.className))).toEqual(['question', 'tabs', 'stage', 'hint']);
			expect(await folded(tab)).toEqual(CLOSED);
			expect(
				await tab.evaluate(() => {
					const button = document.getElementById('ask')?.getBoundingClientRect();
					const walker = document.createTreeWalker(document.querySelector('#question .context') as Node, NodeFilter.SHOW_TEXT);
					const lines: DOMRect[] = [];
					for (let node = walker.nextNode(); node; node = walker.nextNode()) {
						const range = document.createRange();
						range.selectNodeContents(node);
						lines.push(...[...range.getClientRects()].filter((rect) => rect.width > 0));
					}
					if (!button) return null;
					const beside = lines.filter((rect) => rect.top < button.bottom - 4);
					return { first: beside.length > 0 && beside.every((rect) => rect.right <= button.left), under: lines.some((rect) => rect.top >= button.bottom - 4 && rect.right > button.left) };
				}),
			).toEqual({ first: true, under: true });
			const inside = () =>
				tab.evaluate(() => {
					const fold = (document.querySelector('#question .fold') as HTMLElement).getBoundingClientRect();
					const button = (document.getElementById('ask') as HTMLElement).getBoundingClientRect();
					return button.top >= fold.top && button.bottom <= fold.bottom && button.right <= fold.right;
				});
			expect(await inside()).toBe(true);
			const page = await frameHeight(tab);
			const boxHeight = () => tab.locator('#question').evaluate((node: HTMLElement) => node.getBoundingClientRect().height);
			const shut = await boxHeight();
			await tab.locator('#ask').tap();
			await settle(tab);
			const opened = await folded(tab);
			expect(opened).toMatchObject({ expanded: 'true', button: true });
			expect(opened.height ?? 0).toBeGreaterThan(44 * 2);
			expect(await tab.locator('#question').textContent()).toBe(LONG.replace(/\*\*/g, ''));
			expect(Math.round(page - (await frameHeight(tab)))).toBe(Math.round((await boxHeight()) - shut));
			expect(await inside()).toBe(true);
			await tab.locator('#ask').tap();
			await settle(tab);
			expect(await folded(tab)).toEqual(CLOSED);
			expect(await frameHeight(tab)).toBe(page);
		});

		const tapAt = async (tab: Page, selector: string, dx: number, dy: number) => {
			const box = await tab.locator(selector).boundingBox();
			if (!box) throw new Error(`${selector} missing`);
			await tab.touchscreen.tap(box.x + dx, box.y + dy);
		};

		test('a tap on the folded text opens the question, Escape closes it, and while it is open a pill and a key still change the tab', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { device: 'phone', question: LONG });
			await preview(tab, 0);
			await tapAt(tab, '#question .fold', 20, 30);
			await settle(tab);
			expect(await folded(tab)).toMatchObject({ expanded: 'true' });
			await tab.getByRole('tab', { name: 'B', exact: true }).tap();
			await settled(tab, 'B');
			await tab.keyboard.press('ArrowLeft');
			await settled(tab, 'A');
			expect(await folded(tab)).toMatchObject({ expanded: 'true' });
			await tab.keyboard.press('Escape');
			await settle(tab);
			expect(await folded(tab)).toEqual(CLOSED);
		});

		test('the question slides with a height transition, and with reduced motion it opens and closes at once', async () => {
			const run = (tab: Page) =>
				tab.evaluate(() => {
					const fold = document.querySelector('#question .fold') as HTMLElement;
					(document.getElementById('ask') as HTMLElement).click();
					return fold.getAnimations().map((animation) => (animation as CSSTransition).transitionProperty);
				});
			const moving = await open(stacked([2000, 2000]), { question: LONG });
			await moving.page.locator('#ask').waitFor();
			expect(await run(moving.page)).toContain('height');
			await context?.close();
			const still = await open(stacked([2000, 2000]), { question: LONG, reducedMotion: 'reduce' });
			await still.page.locator('#ask').waitFor();
			expect(await run(still.page)).toEqual([]);
			expect((await folded(still.page)).height ?? 0).toBeGreaterThan(44);
			expect(await run(still.page)).toEqual([]);
			expect(await folded(still.page)).toEqual(CLOSED);
		});

		test('a folded link takes no tap and no focus: a tap or Enter on it opens the question alone, and Tab skips it and a hidden code block', async () => {
			const code = `\n\n\`\`\`\n${'x'.repeat(300)}\n\`\`\``;
			const { page: tab } = await open(stacked([2000, 2000]), { device: 'phone', question: `See [the docs](https://example.com/docs). ${LONG}${code}` });
			await preview(tab, 0);
			await tab.locator('#ask').focus();
			await tab.keyboard.press('Tab');
			expect(await tab.evaluate(() => ({ inside: document.activeElement?.closest('#question .context') ?? null, top: document.querySelector('#question .fold')?.scrollTop }))).toEqual({ inside: null, top: 0 });
			const link = await tab.locator('#question .link').boundingBox();
			if (!link) throw new Error('link missing');
			await tab.touchscreen.tap(link.x + link.width / 2, link.y + link.height / 2);
			await settle(tab);
			expect(await tab.evaluate(() => Reflect.get(window, 'opened'))).toEqual([]);
			expect(await folded(tab)).toMatchObject({ expanded: 'true' });
			await tab.locator('#ask').tap();
			await settle(tab);
			await tab.locator('#question .link').focus();
			await tab.keyboard.press('Enter');
			await settle(tab);
			expect(await tab.evaluate(() => Reflect.get(window, 'opened'))).toEqual([]);
			expect(await folded(tab)).toMatchObject({ expanded: 'true' });
		});

		test('the folded text stays in the accessibility tree of chromium, and Escape from a link of the open question puts focus on the chevron', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { question: `See [the docs](https://example.com/docs). ${LONG}` });
			await preview(tab, 0);
			if (engine === chromium) {
				const { nodes } = await (await tab.context().newCDPSession(tab)).send('Accessibility.getFullAXTree');
				expect(nodes.some((node) => String(node.name?.value ?? '').includes('The page keeps the swipe'))).toBe(true);
			}
			await tab.locator('#ask').click();
			await settle(tab);
			await tab.locator('#question .link').focus();
			await tab.keyboard.press('Escape');
			expect(await tab.evaluate(() => document.activeElement?.id)).toBe('ask');
		});

		test('Escape pressed in a page closes the question', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { question: LONG });
			const frame = await preview(tab, 0);
			await tab.locator('#ask').click();
			await settle(tab);
			await frame.locator('#button').click();
			await tab.keyboard.press('Escape');
			await tab.waitForFunction(() => document.getElementById('ask')?.getAttribute('aria-expanded') === 'false');
			await settle(tab);
			expect(await folded(tab)).toEqual(CLOSED);
		});

		test('while it closes the question shows all its text unmasked, and the folded fade comes once it is closed', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { question: LONG });
			await tab.locator('#ask').click();
			await settle(tab);
			const mask = () =>
				tab.evaluate(() => {
					const style = getComputedStyle(document.querySelector('#question .context') as Element);
					return style.maskImage || style.webkitMaskImage;
				});
			expect(
				await tab.evaluate(() => {
					(document.getElementById('ask') as HTMLElement).click();
					const style = getComputedStyle(document.querySelector('#question .context') as Element);
					return style.maskImage || style.webkitMaskImage;
				}),
			).toBe('none');
			await settle(tab);
			expect(await mask()).not.toBe('none');
		});

		test('a slide reversed halfway keeps the text unmasked until the panel is shut, and ends open or folded as last asked', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { question: LONG });
			await tab.locator('#ask').waitFor();
			const masked = await tab.evaluate(async () => {
				const fold = document.querySelector('#question .fold') as HTMLElement;
				const button = document.getElementById('ask') as HTMLElement;
				button.click();
				await new Promise((resolve) => setTimeout(resolve, 60));
				button.click();
				const wrong: number[] = [];
				const end = performance.now() + 350;
				while (performance.now() < end) {
					const style = getComputedStyle(fold);
					const text = getComputedStyle(fold.querySelector('.context') as Element);
					const height = fold.getBoundingClientRect().height - parseFloat(style.paddingTop);
					if ((text.maskImage || text.webkitMaskImage) !== 'none' && height > 45) wrong.push(height);
					await new Promise((resolve) => requestAnimationFrame(resolve));
				}
				return wrong;
			});
			expect(masked).toEqual([]);
			await settle(tab);
			expect(await folded(tab)).toEqual(CLOSED);
			await tab.locator('#ask').click();
			await settle(tab);
			const full = (await folded(tab)).height ?? 0;
			await tab.evaluate(async () => {
				const button = document.getElementById('ask') as HTMLElement;
				button.click();
				await new Promise((resolve) => setTimeout(resolve, 60));
				button.click();
			});
			await settle(tab);
			expect(await folded(tab)).toEqual({ expanded: 'true', button: true, height: full });
		});

		test('the chevron stays in sight while a long open question scrolls, and a wide code line scrolls sideways', async () => {
			const code = `\n\n\`\`\`\n${'x'.repeat(300)}\n\`\`\``;
			const { page: tab } = await open(stacked([2000, 2000]), { device: 'phone', question: `${LONG.repeat(4)}${code}` });
			await tab.locator('#ask').tap();
			await settle(tab);
			const sight = await tab.evaluate(() => {
				const fold = document.querySelector('#question .fold') as HTMLElement;
				fold.scrollTop = fold.scrollHeight;
				const port = fold.getBoundingClientRect();
				const button = (document.getElementById('ask') as HTMLElement).getBoundingClientRect();
				const pre = fold.querySelector('pre') as HTMLElement;
				pre.scrollLeft = 100;
				return { scrolled: fold.scrollTop > 0, inside: button.top >= port.top - 1 && button.bottom <= port.bottom + 1, sideways: pre.scrollLeft };
			});
			expect(sight).toEqual({ scrolled: true, inside: true, sideways: 100 });
		});

		test('a resize measures the question again: three lines at 390 px show whole at 1100 px, fold again at 390 px, and show whole once closed after a resize while open', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { device: 'phone', question: 'Which one? '.repeat(9) });
			await preview(tab, 0);
			expect(await folded(tab)).toEqual(CLOSED);
			await tab.setViewportSize({ width: 1100, height: 844 });
			await tab.waitForFunction(() => getComputedStyle(document.getElementById('ask') as Element).display === 'none');
			expect(await folded(tab)).toEqual({ expanded: 'false', button: false, height: 22 });
			await tab.setViewportSize({ width: 390, height: 844 });
			await tab.waitForFunction(() => getComputedStyle(document.getElementById('ask') as Element).display !== 'none');
			expect(await folded(tab)).toEqual(CLOSED);
			await tab.locator('#ask').tap();
			await settle(tab);
			await tab.setViewportSize({ width: 1100, height: 844 });
			await tab.locator('#ask').tap();
			await settle(tab);
			expect(await folded(tab)).toEqual({ expanded: 'false', button: false, height: 22 });
		});

		test('a selection in the folded text keeps it folded, and an open question fits its text after a resize', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { device: 'phone', question: `${LONG}\n\n### Heading\n\n${LONG}` });
			await preview(tab, 0);
			expect(
				await tab.evaluate(() => {
					const first = document.querySelector('#question .context p') as Node;
					getSelection()?.selectAllChildren(first);
					(document.querySelector('#question .fold') as HTMLElement).click();
					return document.getElementById('ask')?.getAttribute('aria-expanded');
				}),
			).toBe('false');
			await tab.evaluate(() => getSelection()?.removeAllRanges());
			await tab.locator('#ask').tap();
			await settle(tab);
			await tab.setViewportSize({ width: 844, height: 844 });
			await tab.waitForFunction(() => {
				const fold = document.querySelector('#question .fold') as HTMLElement;
				const text = fold.querySelector('.context') as HTMLElement;
				return Math.abs(fold.getBoundingClientRect().bottom - text.getBoundingClientRect().bottom) < 1;
			});
		});

		test('a focused link of a whole question hands focus to the chevron once a resize folds it', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { question: `${'Which one? '.repeat(9)}See [the docs](https://example.com/docs).` });
			await preview(tab, 0);
			expect(await folded(tab)).toMatchObject({ button: false });
			await tab.locator('#question .link').focus();
			await tab.setViewportSize({ width: 390, height: 844 });
			await tab.waitForFunction(() => document.activeElement?.id === 'ask');
		});

		test('the view keeps its content inside the safe area and the content safe area that Telegram reports', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { device: 'phone', question: LONG });
			await preview(tab, 0);
			const edges = await tab.evaluate(() => {
				const root = document.documentElement.style;
				[['safe-area-inset-top', 59], ['content-safe-area-inset-top', 46], ['safe-area-inset-bottom', 34]].forEach(([name, px]) => root.setProperty(`--tg-${name}`, `${px}px`));
				const top = (document.getElementById('question') as HTMLElement).getBoundingClientRect().top;
				const bottom = (document.querySelector('.hint') as HTMLElement).getBoundingClientRect().bottom;
				return { top: Math.round(top), gap: Math.round(innerHeight - bottom) };
			});
			expect(edges).toEqual({ top: 59 + 46 + 12, gap: 34 });
		});

		test('in a landscape phone view with Telegram insets an open long question leaves the page in sight, and a late side inset folds it again', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { device: 'phone', question: LONG.repeat(3) });
			await tab.setViewportSize({ width: 844, height: 390 });
			await preview(tab, 0);
			await tab.evaluate(() => document.documentElement.style.setProperty('--tg-safe-area-inset-top', '70px'));
			await tab.locator('#ask').click();
			await settle(tab);
			expect(await frameHeight(tab)).toBeGreaterThan(40);
			await tab.locator('#ask').click();
			await settle(tab);
			await context?.close();
			const { page: wide } = await open(stacked([2000, 2000]), { question: 'Which one? '.repeat(12) });
			await preview(wide, 0);
			expect(await folded(wide)).toMatchObject({ button: false });
			await wide.evaluate(() => ['left', 'right'].forEach((side) => document.documentElement.style.setProperty(`--tg-safe-area-inset-${side}`, '300px')));
			await wide.waitForFunction(() => getComputedStyle(document.getElementById('ask') as Element).display !== 'none');
		});

		test('a link in the question opens through Telegram and leaves the question open', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { question: `${LONG} See [the docs](https://example.com/docs).` });
			await tab.locator('#ask').click();
			await settle(tab);
			await tab.locator('#question .link').click();
			expect(await tab.evaluate(() => Reflect.get(window, 'opened'))).toEqual(['https://example.com/docs']);
			expect(await folded(tab)).toMatchObject({ expanded: 'true' });
		});

		test('a question of two lines shows whole without a button, in a view of one tab too, and a view without a question shows none', async () => {
			const one = await open(stacked([2000]).slice(0, 1), { question: 'Which one?' });
			await preview(one.page, 0);
			expect(await one.page.locator('#view > *').evaluateAll((nodes) => nodes.map((node) => node.id || node.className))).toEqual(['question', 'stage', 'hint']);
			expect(await folded(one.page)).toEqual({ expanded: 'false', button: false, height: 22 });
			expect(await one.page.locator('#question').textContent()).toBe('Which one?');
			await context?.close();
			const none = await open(stacked([2000, 2000]));
			await preview(none.page, 0);
			expect(await none.page.locator('#question').count()).toBe(0);
			expect(await none.page.locator('#tabs [role="tab"]').count()).toBe(2);
		});

		test('a question that shows late appears above the pill row, takes its height from the page once, and opens and closes', async () => {
			const { page: tab } = await open(stacked([2000, 2000]), { question: LONG, late: true });
			await preview(tab, 0);
			const height = await frameHeight(tab);
			await tab.locator('#ask').waitFor({ timeout: 15_000 });
			expect(await folded(tab)).toEqual(CLOSED);
			const box = await tab.locator('#question').evaluate((node: HTMLElement) => node.getBoundingClientRect().height + parseFloat(getComputedStyle(node).marginTop));
			expect(Math.round(height - (await frameHeight(tab)))).toBe(Math.round(box));
			await tab.locator('#ask').click();
			await settle(tab);
			expect(await folded(tab)).toMatchObject({ expanded: 'true' });
			await tab.keyboard.press('Escape');
			await settle(tab);
			expect(await folded(tab)).toEqual(CLOSED);
		});

		test('with the question present a full-height container keeps its share across tabs', async () => {
			const { page: tab } = await open(contained(FULL_HEIGHT), { device: 'phone', question: LONG });
			await preview(tab, 0);
			await scrollIn(tab, 0, 740, 'main');
			const first = await share(tab, 0, 'main');
			expect(first).toBeGreaterThan(0.2);
			await tab.getByRole('tab', { name: 'B', exact: true }).click();
			await settled(tab, 'B');
			expect(Math.abs((await share(tab, 1, 'main')) - first)).toBeLessThanOrEqual(0.01);
		});

		const titled = (): Tab[] => ['A: Kompakt', 'B: Weit', 'C'].map((label) => ({ label, content: page(`<h1>${label}</h1>`) }));

		test.each([
			['its tag', [['c', 'B']], 'B Weit'],
			['its full label', [['c', 'B: Weit']], 'B Weit'],
			['a tag without a title', [['c', 'C']], 'C'],
			['t before c', [['t', 'A: Kompakt'], ['c', 'B']], 'A Kompakt'],
		] as const)('an old desk button opens the tab of %s', async (_, query, label) => {
			const { page: tab, requests } = await open(titled(), { query: query.map(([name, value]) => [name, value]) });
			await selected(tab, label);
			expect(await tab.locator('#question').count()).toBe(0);
			expect(requests.filter((url) => url.includes('/api/view?')).every((url) => !url.includes('q='))).toBe(true);
		});

		test('an old desk question shows behind the button with its http links, and the host is asked for no question', async () => {
			const question = 'Which one?\nA: Fast\n  B: Thorough\n\nSee the docs and this.';
			const start = question.indexOf('the docs');
			const links: [string, string][] = [
				['l', `${start},${start + 8},https://example.com/docs`],
				['l', `${start + 2},${start + 5},https://example.com/overlap`],
				['l', `${question.indexOf('this')},${question.indexOf('this') + 4},javascript:alert(1)`],
			];
			const { page: tab, requests } = await open(titled(), { query: [['q', question], ...links, ['c', 'B']] });
			await selected(tab, 'B Weit');
			await tab.locator('#ask').click();
			expect(await tab.locator('#question p').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).innerText))).toEqual(['Which one?\nA: Fast\n  B: Thorough', 'See the docs and this.']);
			expect(await tab.locator('#question .link').allTextContents()).toEqual(['the docs']);
			await tab.locator('#question .link').click();
			expect(await tab.evaluate(() => Reflect.get(window, 'opened'))).toEqual(['https://example.com/docs']);
			expect(requests.filter((url) => url.includes('/api/view?')).every((url) => !url.includes('q='))).toBe(true);
		});

		test.each([
			['no ref', [['q', 'Ok?']], 'Ok?'],
			['a ref with a link', [['q', 'Docs'], ['l', '0,4,https://example.com/docs']], 'Docs'],
		] as const)('a q that is %s is an old question, and a ref alone asks the host', async (_, query, text) => {
			const old = await open(titled(), { query: query.map(([name, value]) => [name, value]) });
			expect(await old.page.locator('#question').textContent()).toBe(text);
			expect(old.requests.some((url) => url.includes('/api/view?') && url.includes('q='))).toBe(false);
			await context?.close();
			const current = await open(titled(), { question: 'From the host' });
			expect(await current.page.locator('#question').textContent()).toBe('From the host');
			expect(current.requests.some((url) => url.includes('/api/view?') && url.includes('q=ask1'))).toBe(true);
		});

		test('in a view of pages and a Markdown tab, keys pass the Markdown tab and the pages keep their share', async () => {
			const tall = (label: string) => page(`<h1>${label}</h1><div style="height: 3000px"></div>`);
			const tabs: Tab[] = [
				{ label: 'A', content: tall('A') },
				{ label: 'Notes', content: { markdown: `# Notes\n\n${'Zeile\n\n'.repeat(200)}` } },
				{ label: 'B', content: tall('B') },
			];
			const { page: tab } = await open(tabs, { device: 'phone' });
			await preview(tab, 0);
			await preview(tab, 2);
			await scrollToShare(tab, 0, 0.4);
			await tab.keyboard.press('ArrowRight');
			await selected(tab, 'Notes');
			expect(await tab.locator('#panels > section:nth-child(2)').evaluate((panel) => panel.scrollTop)).toBe(0);
			await tab.keyboard.press('ArrowRight');
			await settled(tab, 'B');
			expect(await share(tab, 2)).toBe(0.4);
		});

		test('a page frame that loads late takes the share on its load, before it is shown', async () => {
			const tabs: Tab[] = [
				{ label: 'A', content: page('<h1>A</h1><div style="height: 3000px"></div>') },
				{ label: 'B', content: page('<h1>B</h1><img src="media:0" width="1" height="1"><div style="height: 3000px"></div>') },
			];
			const { page: tab } = await open(tabs, { device: 'phone', delayMedia: 1500, media: [{ type: 'image/png', bytes: MEDIA.png }] });
			await preview(tab, 0);
			expect(await tab.locator(frameSelector(1)).count()).toBe(0);
			await scrollToShare(tab, 0, 0.4);
			await tab.locator(frameSelector(1)).waitFor({ state: 'attached', timeout: 10_000 });
			await (await preview(tab, 1)).waitForFunction(() => document.readyState === 'complete', undefined, { polling: 100, timeout: 10_000 });
			await drain(tab);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(await share(tab, 1)).toBe(0.4);
		});

		test('pages that reload on a theme change take the share again', async () => {
			const { page: tab } = await open(stacked([3000, 1500]), { device: 'phone' });
			await preview(tab, 0);
			await preview(tab, 1);
			await scrollToShare(tab, 0, 0.4);
			const before = await (await preview(tab, 0)).evaluate(() => document.documentElement.dataset.generation ?? 'first');
			expect(before).toBe('first');
			await tab.evaluate(() => {
				Reflect.set(Reflect.get(window, 'Telegram').WebApp, 'colorScheme', 'dark');
				Reflect.get(window, 'tgHandlers').themeChanged();
			});
			await tab.waitForFunction(() => document.querySelector('#panels iframe')?.getAttribute('srcdoc')?.includes('color-scheme: dark'));
			for (const index of [0, 1]) {
				const frame = await preview(tab, index);
				await frame.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'dark', undefined, { polling: 100 });
			}
			await drain(tab);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect([await share(tab, 0), await share(tab, 1)]).toEqual([0.4, 0.4]);
		});

		test('a page plays a data: video, and loads no media from another host', async () => {
			const tabs: Tab[] = [
				{ label: 'A', content: page(`<h1>A</h1><video id="clip" muted playsinline src="${CLIP}"></video><img src="https://elsewhere.example/x.png"><video src="https://elsewhere.example/v.mp4"></video>`) },
				{ label: 'B', content: page('<h1>B</h1>') },
			];
			const { page: tab, requests } = await open(tabs);
			const frame = await preview(tab, 0);
			const played = await frame.evaluate(async () => {
				const video = document.getElementById('clip') as HTMLVideoElement;
				await video.play();
				await new Promise((resolve) => setTimeout(resolve, 400));
				return video.currentTime;
			});
			expect(played).toBeGreaterThan(0);
			expect(requests.filter((url) => url.includes('elsewhere.example'))).toEqual([]);
		});

		test('a page runs the bridge alone: inline scripts, handlers, script links, nested content and an allowed host stay blocked, and the page reaches no launch data', async () => {
			const hostile = [
				'<h1>A</h1><p id="plain" style="display: block; height: 40px">Text</p>',
				"<script>document.documentElement.dataset.inline = 'ran';</script>",
				'<script src="https://telegram.org/probe.js"></script>',
				`<img src="data:," onerror="document.documentElement.dataset.handler = 'ran'">`,
				`<a id="script-link" href="javascript:document.documentElement.dataset.link = 'ran'">Link</a>`,
				`<iframe id="nested" srcdoc="<script>document.documentElement.dataset.nested = 'ran';</script><p>inner</p>"></iframe>`,
			].join('');
			const answer = { view: { v: 1, tabs: [{ label: 'A', content: { page: hostile } }, { label: 'B', content: { page: '<h1>B</h1>' } }] }, media: [], expiresAt: Date.now() + 86_400_000 };
			const { page: tab } = await open(stacked([100, 100]), { answer });
			const frame = await preview(tab, 0);
			await tapPage(tab, 0.9, 'plain', false);
			await selected(tab, 'B');
			await tab.keyboard.press('ArrowLeft');
			await settled(tab, 'A');
			await frame.locator('#script-link').click();
			await new Promise((resolve) => setTimeout(resolve, 300));
			const nested = frame.childFrames()[0];
			expect(await nested?.evaluate(() => document.documentElement.dataset.nested ?? 'blocked')).toBe('blocked');
			expect(await frame.evaluate(() => ({ ...document.documentElement.dataset }))).toEqual({});
			const reach = await frame.evaluate(() => {
				const attempt = (read: () => unknown) => {
					try {
						return String(read() ?? 'absent');
					} catch {
						return 'blocked';
					}
				};
				return {
					own: attempt(() => sessionStorage.getItem('__telegram__initParams')),
					parent: attempt(() => parent.sessionStorage.getItem('__telegram__initParams')),
					dom: attempt(() => parent.document.title),
					telegram: attempt(() => Reflect.get(parent, 'Telegram')),
					base: document.baseURI.includes('tgWebAppData') ? 'launch data' : 'clean',
				};
			});
			expect(reach).toEqual({ own: 'blocked', parent: 'blocked', dom: 'blocked', telegram: 'blocked', base: 'clean' });
		});
	});
