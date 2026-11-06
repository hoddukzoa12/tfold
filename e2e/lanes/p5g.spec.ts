import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page, Worker } from '@playwright/test';
import { extensionDir, fixtures, launch, type Harness } from '../harness.ts';
import { expect, test } from '../lane.ts';

const lead = '#mwAQ > p:not(.mw-empty-elt):not([data-tfold-overlay])';
const properties = '#mwAmA > p:not([data-tfold-overlay])';
const latchMs = 400;

type RawCdp = { send(method: string, params?: object): Promise<unknown>; detach(): Promise<void> };
type Mock = { baseUrl: string; delayMs: number; requests: number; close(): Promise<void> };
type Paragraph = { hidden: boolean; level: string | null; fold: string | null; badge: string | null };
type PageState = { overlays: number; badges: number; hidden: number };
type Worlds = { live: number; cutOff: number };

async function mockProvider(): Promise<Mock> {
	const mock: Mock = { baseUrl: '', delayMs: 0, requests: 0, close: () => Promise.resolve() };
	const server = http.createServer((request, response) => {
		const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
		if (request.method === 'OPTIONS') {
			response.writeHead(204, cors).end();
			return;
		}
		let raw = '';
		request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		request.on('end', () => {
			mock.requests++;
			const prompt =(JSON.parse(raw) as { messages: { content: string }[] }).messages.at(-1)?.content ?? '';
			const units = [...prompt.matchAll(/^\[U(\d+)\]/gm)].map(([, n]) => ({ id: `U${n}`, takeaway: `Mock takeaway ${n}`, reason: '', evidence: [0] }));
			const body = JSON.stringify({
				id: 'gen-mock',
				choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ units }) } }],
				usage: { prompt_tokens: 0, completion_tokens: 0 },
			});
			setTimeout(() => response.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(body), mock.delayMs);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	mock.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	mock.close = async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	};
	return mock;
}

const saveKey = (worker: Worker, mock: Mock) =>
	worker.evaluate(
		(baseUrl) => chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter: { apiKey: 'mock-key', baseUrl, model: 'mock/model' } }, hintSeen: true }),
		mock.baseUrl,
	);

const signIn = (worker: Worker) => worker.evaluate(() => chrome.storage.local.set({ account: { kind: 'free' } }));

const seed = async (worker: Worker, mock: Mock) => {
	await saveKey(worker, mock);
	await signIn(worker);
};

function paragraph(page: Page, selector: string): Promise<Paragraph> {
	return page.evaluate((selector) => {
		const el = document.querySelector(selector);
		if (!el) throw new Error(`no paragraph matches ${selector}`);
		const overlay = el.nextElementSibling?.hasAttribute('data-tfold-overlay') ? el.nextElementSibling : null;
		return {
			hidden: !el.checkVisibility(),
			level: overlay?.getAttribute('data-tf-level') ?? null,
			fold: overlay?.getAttribute('data-tf-fold') ?? null,
			badge: overlay?.getAttribute('data-tf-badge') ?? null,
		};
	}, selector);
}

const pageState = (page: Page): Promise<PageState> =>
	page.evaluate(() => ({
		overlays: document.querySelectorAll('[data-tfold-overlay]').length,
		badges: document.querySelectorAll('[data-tf-badge]').length,
		hidden: document.querySelectorAll('[data-tfold-hidden]').length,
	}));

const restoredPage: PageState = { overlays: 0, badges: 0, hidden: 0 };

async function foldBy(h: Harness, selector: string, steps: number): Promise<void> {
	await h.page.evaluate((selector) => {
		for (const marked of document.querySelectorAll('[data-p5g-target]')) marked.removeAttribute('data-p5g-target');
		const el = document.querySelector(selector);
		(el?.checkVisibility() ? el : el?.nextElementSibling)?.setAttribute('data-p5g-target', '');
	}, selector);
	const point = await h.pointAt('[data-p5g-target]');
	await h.foldAt(point.x, point.y, steps);
}

async function folded(h: Harness, selector: string, level: number): Promise<Paragraph> {
	const want = (shown: Paragraph) => shown.level === String(level) && (shown.fold === 'model' || shown.badge !== null);
	await expect.poll(async () => want(await paragraph(h.page, selector)), { timeout: 15_000, intervals: [50] }).toBe(true);
	return paragraph(h.page, selector);
}

// With reduced motion a fold swaps at once, so no late change to the page wakes a cut-off script before the step under test.
const launchReducedMotion = (headless: boolean, extension: string) =>
	launch({ headless, allowLiveHosts: ['127.0.0.1'], reducedMotion: 'reduce' }, extension);

const recordBadges = (page: Page) =>
	page.evaluate(() => {
		const shown: string[] = [];
		Object.assign(globalThis, { p5gBadges: shown });
		new MutationObserver((records) => {
			for (const record of records) {
				const added = [...record.addedNodes].filter((node): node is Element => node instanceof Element);
				for (const el of record.type === 'attributes' ? [record.target as Element] : added) {
					const badge = el.getAttribute('data-tf-badge');
					if (badge !== null) shown.push(badge);
				}
			}
		}).observe(document.documentElement, { subtree: true, childList: true, attributeFilter: ['data-tf-badge'] });
	});

const badgesShown = (page: Page) => page.evaluate(() => (globalThis as unknown as { p5gBadges: string[] }).p5gBadges);

const recordWheels = (page: Page) =>
	page.evaluate(() => {
		const wheels: boolean[] = [];
		Object.assign(globalThis, { p5gWheels: wheels });
		addEventListener('wheel', (event) => {
			if (event.ctrlKey) wheels.push(event.defaultPrevented);
		});
	});

const preventedWheels = (page: Page) =>
	page.evaluate(() => {
		const wheels = (globalThis as unknown as { p5gWheels: boolean[] }).p5gWheels;
		return { seen: wheels.length, prevented: wheels.filter(Boolean).length };
	});

const recordFolds = (page: Page) =>
	page.evaluate(() => {
		const seen = { folds: 0 };
		Object.assign(globalThis, { p5gSeen: seen });
		new MutationObserver((records) => {
			seen.folds += records.filter((record) => record.oldValue === null).length;
		}).observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-tfold-hidden'] });
	});

const foldsSeen = (page: Page) => page.evaluate(() => (globalThis as unknown as { p5gSeen: { folds: number } }).p5gSeen.folds);

const [altKey, ctrlKey, shiftKey] = [1, 2, 8];
const foldKey = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: altKey | shiftKey };

async function pressUntil(h: Harness, at: { x: number; y: number }, done: Promise<unknown>): Promise<number> {
	const cdp = await h.context.newCDPSession(h.page);
	let pressing = true;
	const stop = () => (pressing = false);
	void done.then(stop, stop);
	let presses = 0;
	for (; pressing; presses++) {
		const point = { x: at.x + (presses % 2), y: at.y };
		const wheel = Array.from({ length: presses % 8 === 0 ? 6 : 0 }, () =>
			cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 10, modifiers: ctrlKey }),
		);
		await Promise.all([
			cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }),
			cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...foldKey }),
			cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...foldKey }),
			...wheel,
		]);
	}
	await cdp.detach();
	return presses;
}

async function worlds(h: Harness, extensionId: string): Promise<Worlds> {
	const session = await h.context.newCDPSession(h.page);
	try {
		const found: { id: number; frameId?: string }[] = [];
		session.on('Runtime.executionContextCreated', ({ context }) => {
			if (context.origin === `chrome-extension://${extensionId}`) found.push({ id: context.id, frameId: context.auxData?.frameId });
		});
		await session.send('Runtime.enable');
		const { frameTree } = await session.send('Page.getFrameTree');
		const counts: Worlds = { live: 0, cutOff: 0 };
		for (const world of found.filter((candidate) => candidate.frameId === frameTree.frame.id)) {
			const { result } = await session.send('Runtime.evaluate', { contextId: world.id, returnByValue: true, expression: "typeof chrome.runtime?.id === 'string'" });
			counts[result.value === true ? 'live' : 'cutOff']++;
		}
		return counts;
	} finally {
		await session.detach();
	}
}

const startedInOpenTabs = (h: Harness) =>
	h.logs
		.filter((entry) => entry.source === 'worker' && entry.text.startsWith('content script started in '))
		.map((entry) => entry.text.replace(/, \d+ ms$/, ''));
const contentReady = (h: Harness) => h.logs.filter((entry) => entry.source === 'page' && entry.text === 'content ready').length;
const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');

async function browserCdp(h: Harness): Promise<RawCdp> {
	const browser = h.context.browser();
	if (!browser) throw new Error('the context has no browser to install the extension through');
	return browser.newBrowserCDPSession();
}

async function copyBuild(live: string, version: string): Promise<void> {
	await cp(extensionDir, live, { recursive: true });
	const manifest = JSON.parse(await readFile(path.join(live, 'manifest.json'), 'utf8')) as Record<string, unknown>;
	await writeFile(path.join(live, 'manifest.json'), JSON.stringify({ ...manifest, version }));
}

async function reloadExtension(h: Harness, worker: Worker, live: string, version: string): Promise<Worker> {
	await copyBuild(live, version);
	const restarted = h.context.waitForEvent('serviceworker');
	await worker.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
	return restarted;
}

// Chrome refuses to uninstall an extension it loaded from the command line until that extension reloads once.
const makeUninstallable = (h: Harness, live: string) => reloadExtension(h, h.worker, live, '0.1.0');

async function waitForFreshScript(h: Harness, extensionId: string, cutOff: number): Promise<void> {
	await expect
		.poll(() => worlds(h, extensionId), { timeout: 10_000, message: 'a fresh content script runs in the open tab' })
		.toEqual({ live: 1, cutOff });
}

test.describe('open tabs across install, update and reload', () => {
	let live = '';
	let mock: Mock;

	test.beforeEach(async () => {
		live = await mkdtemp(path.join(tmpdir(), 'tfold-live-'));
		await copyBuild(live, '0.1.0');
		mock = await mockProvider();
	});

	test.afterEach(async () => {
		await mock.close();
		await rm(live, { recursive: true, force: true });
	});

	test('lane 1: after tfold goes away, the script left in an open tab restores the page, shows no badge and lets a fold zoom the page', async ({
		headless,
	}) => {
		const h = await launchReducedMotion(headless, live);
		const cdp = await browserCdp(h);
		try {
			await seed(await makeUninstallable(h, live), mock);
			await h.navigate(fixtures.wiki);
			await expect.poll(() => contentReady(h)).toBe(1);
			await foldBy(h, lead, 1);
			const before = await folded(h, lead, 1);

			await cdp.send('Extensions.uninstall', { id: h.extensionId });
			await recordWheels(h.page);
			await h.page.waitForTimeout(latchMs + 100);
			await foldBy(h, properties, 1);
			await h.page.waitForTimeout(500);
			const after = {
				lead: await paragraph(h.page, lead),
				properties: await paragraph(h.page, properties),
				page: await pageState(h.page),
				wheels: await preventedWheels(h.page),
			};
			console.log(`folded before tfold went away: ${JSON.stringify(before)}; after: ${JSON.stringify(after)}`);

			expect(before).toEqual({ hidden: true, level: '1', fold: 'model', badge: null });
			expect(after.lead, 'the folded paragraph is back').toEqual({ hidden: false, level: null, fold: null, badge: null });
			expect(after.properties, 'a fold folds nothing and shows no badge').toEqual({ hidden: false, level: null, fold: null, badge: null });
			expect(after.page, 'nothing of tfold is left on the page').toEqual(restoredPage);
			expect(after.wheels, 'the fold reaches the page zoom').toEqual({ seen: 5, prevented: 0 });
			expect(await worlds(h, h.extensionId)).toEqual({ live: 0, cutOff: 1 });
			expect(errors(h)).toEqual([]);
		} finally {
			await cdp.detach().catch(() => undefined);
			await h.close();
		}
	});

	test('lane 2: a fold reply on its way when tfold goes away brings the page back with no badge and no input', async ({ headless }) => {
		const h = await launchReducedMotion(headless, live);
		const cdp = await browserCdp(h);
		try {
			await seed(await makeUninstallable(h, live), mock);
			await h.navigate(fixtures.wiki);
			await expect.poll(() => contentReady(h)).toBe(1);
			await foldBy(h, lead, 1);
			await folded(h, lead, 1);
			mock.delayMs = 3000;
			await h.page.waitForTimeout(latchMs + 100);
			await foldBy(h, properties, 1);
			const pending = await paragraph(h.page, properties);

			await recordBadges(h.page);
			const gone = Date.now();
			await cdp.send('Extensions.uninstall', { id: h.extensionId });
			await expect.poll(() => pageState(h.page), { timeout: 16_000, intervals: [50] }).toEqual(restoredPage);
			const restoredMs = Date.now() - gone;
			await h.page.waitForTimeout(3500);
			const after = {
				lead: await paragraph(h.page, lead),
				properties: await paragraph(h.page, properties),
				page: await pageState(h.page),
				badges: await badgesShown(h.page),
			};
			console.log(`pending before tfold went away: ${JSON.stringify(pending)}; page restored ${restoredMs} ms after; then ${JSON.stringify(after)}`);

			expect(pending).toEqual({ hidden: true, level: '1', fold: 'local', badge: null });
			expect(after.lead).toEqual({ hidden: false, level: null, fold: null, badge: null });
			expect(after.properties).toEqual({ hidden: false, level: null, fold: null, badge: null });
			expect(after.page).toEqual(restoredPage);
			expect(after.badges, 'no badge showed after tfold went away').toEqual([]);
			expect(errors(h)).toEqual([]);
		} finally {
			await cdp.detach().catch(() => undefined);
			await h.close();
		}
	});

	test('lane 3: tfold installed into an open tab folds there without a reload, and after it is uninstalled the cut-off script restores the page and lets zoom through, twice', async ({
		headless,
	}) => {
		const h = await launchReducedMotion(headless, live);
		const cdp = await browserCdp(h);
		const install = async () => {
			const started = h.context.waitForEvent('serviceworker');
			await cdp.send('Extensions.loadUnpacked', { path: live });
			await seed(await started, mock);
		};
		try {
			await makeUninstallable(h, live);
			await cdp.send('Extensions.uninstall', { id: h.extensionId });
			await h.navigate(fixtures.wiki);
			const rounds: { installed: Paragraph; page: PageState; ready: number; lead: Paragraph; properties: Paragraph; cutOff: PageState; wheels: { seen: number; prevented: number }; worlds: Worlds }[] = [];
			for (let round = 0; round < 2; round++) {
				await install();
				await waitForFreshScript(h, h.extensionId, round);
				await foldBy(h, lead, 1);
				const installed = await folded(h, lead, 1);
				const page = await pageState(h.page);
				const ready = contentReady(h);

				await cdp.send('Extensions.uninstall', { id: h.extensionId });
				await recordWheels(h.page);
				await h.page.waitForTimeout(latchMs + 100);
				await foldBy(h, properties, 1);
				await h.page.waitForTimeout(500);
				rounds.push({
					installed,
					page,
					ready,
					lead: await paragraph(h.page, lead),
					properties: await paragraph(h.page, properties),
					cutOff: await pageState(h.page),
					wheels: await preventedWheels(h.page),
					worlds: await worlds(h, h.extensionId),
				});
				console.log(`install ${round + 1}, then uninstall: ${JSON.stringify(rounds.at(-1))}`);
			}

			for (const [i, round] of rounds.entries()) {
				expect(round.installed, `install ${i + 1}: the open tab folds`).toEqual({ hidden: true, level: '1', fold: 'model', badge: null });
				expect(round.page, `install ${i + 1}: one overlay`).toEqual({ overlays: 1, badges: 0, hidden: 1 });
				expect(round.ready, `install ${i + 1}: one fresh script started`).toBe(i + 1);
				expect(round.lead, `uninstall ${i + 1}: the folded paragraph is back`).toEqual({ hidden: false, level: null, fold: null, badge: null });
				expect(round.properties, `uninstall ${i + 1}: a fold folds nothing`).toEqual({ hidden: false, level: null, fold: null, badge: null });
				expect(round.cutOff, `uninstall ${i + 1}: nothing of tfold is left on the page`).toEqual(restoredPage);
				expect(round.wheels, `uninstall ${i + 1}: the fold reaches the page zoom`).toEqual({ seen: 5, prevented: 0 });
				expect(round.worlds).toEqual({ live: 0, cutOff: i + 1 });
			}
			expect(startedInOpenTabs(h).slice(-2)).toEqual([
				'content script started in 1 of 1 open tabs without one',
				'content script started in 1 of 1 open tabs without one',
			]);
			expect(errors(h)).toEqual([]);
		} finally {
			await cdp.detach().catch(() => undefined);
			await h.close();
		}
	});

	test('lane 4: an update and then a reload leave the open tab with one fresh script that folds without a page reload, and nothing doubles', async ({
		headless,
	}) => {
		const h = await launchReducedMotion(headless, live);
		try {
			await seed(h.worker, mock);
			await h.navigate(fixtures.wiki);
			await expect.poll(() => contentReady(h)).toBe(1);
			await foldBy(h, lead, 1);
			await folded(h, lead, 1);

			let worker = h.worker;
			const rounds: { name: string; restored: PageState; first: Paragraph; second: Paragraph; page: PageState; ready: number }[] = [];
			for (const [round, version] of [
				['update', '0.1.1'],
				['reload', '0.1.1'],
			] as const) {
				worker = await reloadExtension(h, worker, live, version);
				await waitForFreshScript(h, h.extensionId, rounds.length + 1);
				await h.page.waitForTimeout(300);
				const restored = await pageState(h.page);
				await foldBy(h, lead, 1);
				const first = await folded(h, lead, 1);
				await foldBy(h, lead, 1);
				const second = await folded(h, lead, 2);
				const page = await pageState(h.page);
				rounds.push({ name: round, restored, first, second, page, ready: contentReady(h) });
				console.log(`after ${round}: ${JSON.stringify(rounds.at(-1))}`);
			}

			await worker.evaluate(async () => {
				const [tab] = await chrome.tabs.query({ url: ['http://*/*'] });
				await chrome.scripting.executeScript({ target: { tabId: tab?.id ?? -1 }, files: ['content/index.js'] });
			});
			await h.page.waitForTimeout(300);
			await foldBy(h, lead, 1);
			const again = await folded(h, lead, 3);
			const againPage = await pageState(h.page);
			console.log(`after a second injection into the same tab: lead ${JSON.stringify(again)}, page ${JSON.stringify(againPage)}, content ready ${contentReady(h)}`);

			for (const [i, round] of rounds.entries()) {
				expect(round.restored, `${round.name}: the cut-off script left nothing folded`).toEqual(restoredPage);
				expect(round.first).toEqual({ hidden: true, level: '1', fold: 'model', badge: null });
				expect(round.second).toEqual({ hidden: true, level: '2', fold: 'model', badge: null });
				expect(round.page, `${round.name}: one overlay`).toEqual({ overlays: 1, badges: 0, hidden: 1 });
				expect(round.ready, `${round.name}: one fresh script started`).toBe(i + 2);
			}
			expect(again).toEqual({ hidden: true, level: '3', fold: 'model', badge: null });
			expect(againPage).toEqual({ overlays: 1, badges: 0, hidden: 1 });
			expect(contentReady(h)).toBe(3);
			expect(await worlds(h, h.extensionId)).toEqual({ live: 1, cutOff: 2 });
			expect(startedInOpenTabs(h)).toEqual([
				'content script started in 0 of 0 open tabs without one',
				'content script started in 1 of 1 open tabs without one',
				'content script started in 1 of 1 open tabs without one',
			]);
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	});

	test('lane 6: after tfold is turned off and on, open tabs fold without a page reload, a later worker start leaves live tabs alone, and a discarded tab stays discarded', async ({
		headless,
	}) => {
		const h = await launchReducedMotion(headless, live);
		const other = await h.context.newPage();
		const asleep = await h.context.newPage();
		const extensions = await h.context.newPage();
		const cdp = await browserCdp(h);
		try {
			await seed(h.worker, mock);
			await h.navigate(fixtures.wiki);
			await other.goto(new URL(fixtures.arxiv, h.baseURL).href);
			await asleep.goto(new URL(fixtures.react, h.baseURL).href);
			await expect.poll(() => contentReady(h)).toBe(3);
			await h.page.bringToFront();
			await foldBy(h, lead, 1);
			await folded(h, lead, 1);
			const discarded = () => h.context.serviceWorkers()[0]?.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.discarded ?? null, asleep.url());
			await h.worker.evaluate(async (url) => {
				const [tab] = await chrome.tabs.query({ url });
				await chrome.tabs.discard(tab?.id ?? -1);
			}, asleep.url());

			await extensions.goto('chrome://extensions/');
			const setEnabled = (on: boolean) =>
				extensions.evaluate(([id, on]) => new Promise<void>((resolve) => chrome.management.setEnabled(id, on, () => resolve())), [h.extensionId, on] as const);
			await setEnabled(false);
			const restarted = h.context.waitForEvent('serviceworker');
			await setEnabled(true);
			const worker = await restarted;
			await seed(worker, mock);
			await waitForFreshScript(h, h.extensionId, 1);
			await expect.poll(() => startedInOpenTabs(h).length).toBe(2);
			await h.page.waitForTimeout(300);
			const restored = await pageState(h.page);
			await h.page.bringToFront();
			await foldBy(h, lead, 1);
			const refolded = await folded(h, lead, 1);
			const asleepAfterEnable = await discarded();

			const options = await h.context.newPage();
			await options.goto(`chrome-extension://${h.extensionId}/options/options.html`);
			const session = await h.context.newCDPSession(options);
			const statuses: string[] = [];
			session.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
				for (const version of versions) if (version.scriptURL.startsWith(`chrome-extension://${h.extensionId}/`)) statuses.push(version.runningStatus);
			});
			await session.send('ServiceWorker.enable');
			await session.send('ServiceWorker.stopAllWorkers');
			await expect.poll(() => statuses.at(-1), { message: 'the worker stops' }).toBe('stopped');
			await session.detach();
			await options.close();
			await h.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
			await expect.poll(() => startedInOpenTabs(h).length, { message: 'the open tab wakes the worker' }).toBe(3);
			const counts = { ready: contentReady(h), worlds: await worlds(h, h.extensionId), asleep: await discarded() };
			console.log(`turned off and on: ${JSON.stringify({ restored, refolded, asleepAfterEnable })}; after a later worker start: ${JSON.stringify(counts)}; ${JSON.stringify(h.logs.filter((entry) => entry.text.startsWith('content script started in ')).map((entry) => entry.text))}`);

			expect(restored, 'the cut-off script left nothing folded').toEqual(restoredPage);
			expect(refolded).toEqual({ hidden: true, level: '1', fold: 'model', badge: null });
			expect(asleepAfterEnable).toBe(true);
			expect(startedInOpenTabs(h)).toEqual([
				'content script started in 0 of 0 open tabs without one',
				'content script started in 2 of 2 open tabs without one',
				'content script started in 0 of 0 open tabs without one',
			]);
			expect(counts).toEqual({ ready: 5, worlds: { live: 1, cutOff: 1 }, asleep: true });
			expect(errors(h)).toEqual([]);
		} finally {
			await cdp.detach().catch(() => undefined);
			await h.close();
		}
	});

	test('lane 7: signed out, the shortcut and a fold pressed again and again while a fresh copy starts in an open tab never fold and all reach the page, and once an account is stored they fold without a page reload', async ({
		headless,
	}) => {
		const h = await launch({ headless, account: null, allowLiveHosts: ['127.0.0.1'], reducedMotion: 'reduce' }, live);
		try {
			await saveKey(h.worker, mock);
			await h.navigate(fixtures.wiki);
			await expect.poll(() => contentReady(h)).toBe(1);
			await recordWheels(h.page);
			await recordFolds(h.page);
			const at = await h.pointAt(lead);

			const rounds = 10;
			const presses: number[] = [];
			let worker = h.worker;
			for (let round = 0; round < rounds; round++) {
				const started = reloadExtension(h, worker, live, `0.1.${round + 1}`).then(async (restarted) => {
					worker = restarted;
					await expect.poll(() => contentReady(h), { message: 'a fresh copy starts in the open tab' }).toBe(round + 2);
					await h.page.waitForTimeout(100);
				});
				presses.push(await pressUntil(h, at, started));
				await started;
			}
			await h.page.waitForTimeout(latchMs + 100);
			const signedOut = {
				folds: await foldsSeen(h.page),
				lead: await paragraph(h.page, lead),
				page: await pageState(h.page),
				wheels: await preventedWheels(h.page),
				worlds: await worlds(h, h.extensionId),
				requests: mock.requests,
			};

			await signIn(worker);
			await h.page.waitForTimeout(300);
			await foldBy(h, lead, 1);
			const signedIn = await folded(h, lead, 1);
			console.log(`signed out, presses per fresh copy ${presses.join(', ')}: ${JSON.stringify(signedOut)}; once signed in: ${JSON.stringify(signedIn)}, ${mock.requests} provider requests`);

			expect(presses.every((count) => count > 20), 'presses span each fresh copy starting').toBe(true);
			expect(signedOut).toMatchObject({ folds: 0, requests: 0, page: restoredPage, worlds: { live: 1, cutOff: rounds } });
			expect(signedOut.lead, 'the paragraph stays as it was').toEqual({ hidden: false, level: null, fold: null, badge: null });
			expect(signedOut.wheels.seen, 'the folds reached the page').toBeGreaterThan(0);
			expect(signedOut.wheels.prevented, 'no copy held a fold back').toBe(0);
			expect(signedIn).toEqual({ hidden: true, level: '1', fold: 'model', badge: null });
			expect(mock.requests).toBeGreaterThan(0);
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	});

	test('lane 9: a fresh copy started in an open tab speaks the language the reader picked and follows a change, the toolbar follows too, and the cut-off copy throws nothing', async ({
		headless,
	}) => {
		const h = await launchReducedMotion(headless, live);
		try {
			const host = new URL(h.baseURL).hostname;
			const toolbar = (worker: Worker) =>
				worker.evaluate(async () => {
					const [tab] = await chrome.tabs.query({ url: ['http://*/*'] });
					return chrome.action.getTitle({ tabId: tab?.id ?? -1 });
				});
			const badge = async () => (await paragraph(h.page, lead)).badge;

			await h.worker.evaluate(() => chrome.storage.sync.set({ readerLanguage: 'ko' }));
			await h.navigate(fixtures.wiki);
			await expect.poll(() => contentReady(h)).toBe(1);

			const worker = await reloadExtension(h, h.worker, live, '0.1.1');
			await waitForFreshScript(h, h.extensionId, 1);
			await expect.poll(() => toolbar(worker), { message: 'the fresh copy asks for its page state' }).toBe(`${host}에서 tfold가 켜져 있어요`);
			await foldBy(h, lead, 1);
			const korean = await folded(h, lead, 1);

			await worker.evaluate(() => chrome.storage.sync.set({ readerLanguage: 'en' }));
			await expect.poll(badge).toBe('Add a key in tfold settings to get AI summaries');
			await expect.poll(() => toolbar(worker)).toBe(`tfold is on for ${host}`);
			console.log(`injected copy: ${JSON.stringify(korean)}, then ${String(await badge())}`);

			expect(korean.badge).toBe('AI 요약을 받으려면 tfold 설정에서 키를 넣어 주세요');
			expect(await worlds(h, h.extensionId)).toEqual({ live: 1, cutOff: 1 });
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	});

	test('lane 8: a copy cut off while the pointer rests shows no hint, claims none and does not fail reading its text', async ({ headless }) => {
		const h = await launchReducedMotion(headless, live);
		try {
			await seed(h.worker, mock);
			await h.worker.evaluate(() => chrome.storage.local.remove('hintSeen'));
			await h.navigate(fixtures.wiki);
			await expect.poll(() => contentReady(h)).toBe(1);
			await h.page.waitForTimeout(300);

			await copyBuild(live, '0.1.1');
			const restarted = h.context.waitForEvent('serviceworker');
			const { x, y } = await h.pointAt(lead);
			await h.page.mouse.move(x, y);
			await h.worker.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
			const worker = await restarted;
			await waitForFreshScript(h, h.extensionId, 1);
			await h.page.waitForTimeout(1500);
			const after = { hints: await h.page.locator('tf-hint').count(), stored: await worker.evaluate(() => chrome.storage.local.get('hintSeen')), errors: errors(h) };
			console.log(`after the pointer rested past the cut-off: ${JSON.stringify(after)}`);

			expect(after).toEqual({ hints: 0, stored: {}, errors: [] });
		} finally {
			await h.close();
		}
	});
});

const bounded = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
	Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

type Rates = { framesPerSecond: number; mutationsPerSecond: number };

const ratesOver = (page: Page, ms: number, scheme?: 'light' | 'dark'): Promise<Rates> =>
	bounded(
		page.evaluate(
			({ ms, scheme }) =>
				new Promise<Rates>((resolve) => {
					let [frames, mutations] = [0, 0];
					const observer = new MutationObserver((records) => (mutations += records.length));
					observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
					if (scheme) {
						document.documentElement.className = `theme-${scheme}`;
						const panel = document.getElementById('panel');
						if (panel) panel.className = `panel panel-${scheme}`;
					}
					const start = performance.now();
					const tick = () => {
						frames++;
						if (performance.now() - start < ms) {
							requestAnimationFrame(tick);
							return;
						}
						observer.disconnect();
						resolve({ framesPerSecond: Math.round((1000 * frames) / ms), mutationsPerSecond: Math.round((1000 * mutations) / ms) });
					};
					requestAnimationFrame(tick);
				}),
			{ ms, scheme },
		),
		ms + 5000,
		{ framesPerSecond: 0, mutationsPerSecond: Infinity },
	);

const noteBackground = (page: Page) =>
	page.evaluate(() => {
		const note = document.getElementById('wp-note')?.nextElementSibling;
		return note?.matches('[data-tfold-overlay]') ? getComputedStyle(note).backgroundColor : null;
	});

test('lane 10: with a fold on every block, theme switches restyle the folds, and once settled the page draws and tfold writes nothing to it', async ({ headless }) => {
	test.setTimeout(120_000);
	const mock = await mockProvider();
	const h = await launch({ headless, allowLiveHosts: ['127.0.0.1'] });
	try {
		await seed(h.worker, mock);
		await h.navigate('/themes/');
		await expect.poll(() => contentReady(h)).toBe(1);
		const blocks = await h.inContent<number>('globalThis.__tfold.readBlocks().length');
		const settled = () => h.page.waitForFunction(() => document.querySelector('tfold-ghosts, tfold-gap, [data-tf-pending]') === null, undefined, { timeout: 15_000 });
		const setEveryLevel = (level: number) =>
			h.inContent<void>(
				`(() => {
					const tf = globalThis.__tfold;
					for (const { id } of tf.readBlocks()) tf.setLevel(id, ${level});
				})()`,
			);
		await setEveryLevel(1);
		await settled();
		const light = { page: await pageState(h.page), note: await noteBackground(h.page) };

		const seen: Record<string, Rates> = { 'folded, settled': await ratesOver(h.page, 3000) };
		for (const [name, scheme] of [['dark', 'dark'], ['light', 'light'], ['dark again', 'dark']] as const) {
			seen[`class to ${name}, first second`] = await ratesOver(h.page, 1000, scheme);
			seen[`class to ${name}, settled`] = await ratesOver(h.page, 3000);
		}
		await h.page.addStyleTag({ content: 'body, .panel { transition: color .3s, background-color .3s; }' });
		for (const [name, scheme] of [['light', 'light'], ['dark', 'dark']] as const) {
			seen[`a fading class to ${name}, first second`] = await ratesOver(h.page, 1000, scheme);
			seen[`a fading class to ${name}, settled`] = await ratesOver(h.page, 3000);
		}
		const dark = { page: await pageState(h.page), note: await noteBackground(h.page) };
		await h.page.emulateMedia({ colorScheme: 'dark' });
		seen['color scheme to dark, settled'] = await ratesOver(h.page, 3000);
		await setEveryLevel(0);
		await settled();
		const unfolded = await pageState(h.page);
		console.log(`folds in light: ${JSON.stringify(light)}; in dark: ${JSON.stringify(dark)}; after unfolding: ${JSON.stringify(unfolded)}; per second: ${JSON.stringify(seen)}`);

		expect(blocks).toBe(6);
		const folds = { overlays: blocks, badges: 0, hidden: blocks };
		expect(light).toEqual({ page: folds, note: 'rgb(255, 244, 194)' });
		expect(dark, 'the folds stay and read the new theme').toEqual({ page: folds, note: 'rgb(58, 47, 5)' });
		for (const [name, { framesPerSecond, mutationsPerSecond }] of Object.entries(seen)) {
			expect(framesPerSecond, `the page keeps drawing: ${name}`).toBeGreaterThan(20);
			if (name.endsWith('settled')) expect(mutationsPerSecond, `tfold writes nothing once settled: ${name}`).toBe(0);
		}
		expect(unfolded).toEqual(restoredPage);
		expect(errors(h)).toEqual([]);
	} finally {
		await bounded(h.close(), 15_000, undefined);
		await mock.close();
	}
});
