import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { signInUrl } from '../../src/account.ts';
import { extensionDir, fixtures, launch, foldAt, pointAt, type Harness, type Popup } from '../harness.ts';
import { contrastProbe, pairsOf, type Pair } from '../contrast.ts';
import { expect, inKorean, test } from '../lane.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p5e');
const latchMs = 400;
const koWiki = '/wikipedia-ko-black-hole/';
const wikiParagraphs = '#mw-content-text section > p:not(.mw-empty-elt):not([data-tfold-overlay])';

const nth = (selector: string, index: number) => `${selector} >> nth=${index}`;
const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const worker = (h: Harness) => h.context.serviceWorkers().at(-1) ?? h.worker;
const optionsUrl = (h: Harness) => `chrome-extension://${h.extensionId}/options/options.html`;
const hostOf = (h: Harness) => new URL(h.baseURL).hostname;

async function fresh(slug: string): Promise<string> {
	const file = path.join(outDir, `${slug}.png`);
	await mkdir(outDir, { recursive: true });
	await rm(file, { force: true });
	return file;
}

const hintSeen = (h: Harness, seen = true) => worker(h).evaluate((hintSeen) => chrome.storage.local.set({ hintSeen }), seen);
const saveKey = (h: Harness, baseUrl?: string) =>
	worker(h).evaluate(
		(openrouter) => chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter } }),
		baseUrl ? { apiKey: 'test-key', baseUrl, model: 'mock/model' } : { apiKey: 'test-key' },
	);
const ready = (h: Harness, page: Page = h.page) => expect.poll(() => page.evaluate(() => document.readyState)).toBe('complete');
const folded = async (h: Harness) => (await h.readBlocks()).filter((block) => block.level !== 0).length;
const toolbar = (h: Harness) =>
	worker(h).evaluate(async () => {
		const [tab] = await chrome.tabs.query({ active: true });
		if (tab?.id === undefined) return null;
		return { badge: await chrome.action.getBadgeText({ tabId: tab.id }), title: await chrome.action.getTitle({ tabId: tab.id }) };
	});

async function pointOn(h: Harness, index: number, page: Page = h.page): Promise<{ x: number; y: number }> {
	await page.evaluate(
		({ selector, index }) => {
			for (const marked of document.querySelectorAll('[data-p5e-target]')) marked.removeAttribute('data-p5e-target');
			const el = document.querySelectorAll(selector)[index];
			(el?.checkVisibility() ? el : el?.nextElementSibling)?.setAttribute('data-p5e-target', '');
		},
		{ selector: wikiParagraphs, index },
	);
	return page === h.page ? h.pointAt('[data-p5e-target]') : pointAt(page, await h.context.newCDPSession(page), '[data-p5e-target]');
}

async function foldBy(h: Harness, index: number, steps = 1): Promise<void> {
	const { x, y } = await pointOn(h, index);
	await h.foldAt(x, y, steps);
	await h.page.waitForTimeout(latchMs + 100);
}

type PopupState = {
	lang: string;
	shown: string[];
	signedOut: { text: string | null; button: string | null };
	site: { checked: string | null; disabled: boolean; title: string | null; host: string | null };
	provider: { title: string | null; state: string | null; addKey: string | null };
	how: string | null;
	fold: string | null;
	unfold: string | null;
	scroll: string | null;
	usage: { left: string | null; trial: string | null; value: string | null; width: string; low: string | null; reset: string | null };
	settings: string | null;
	mark: number;
	size: [number, number];
};

const readPopup = (popup: Popup) =>
	popup.evaluate<PopupState>(`(() => {
		const visible = (selector) => document.querySelector(selector)?.checkVisibility() === true;
		const text = (selector) => (visible(selector) ? document.querySelector(selector).textContent.trim() : null);
		const site = document.getElementById('site');
		return {
			lang: document.documentElement.lang,
			shown: ['.wordmark', '#signed-out', '#usage', '#site', '#provider-title', '#fold-keys', '#settings'].filter(visible),
			signedOut: { text: text('#signed-out p'), button: text('#continue') },
			site: { checked: site.getAttribute('aria-checked'), disabled: site.disabled, title: text('#site-title'), host: text('#site-host') },
			provider: { title: text('#provider-title'), state: text('#provider-state'), addKey: text('#add-key') },
			how: text('#how-title'),
			fold: text('#fold-keys'),
			unfold: text('#unfold-keys'),
			scroll: text('#scroll-keys'),
			usage: {
				left: text('#usage-left'),
				trial: text('#trial-left') || null,
				value: document.getElementById('meter').getAttribute('aria-valuenow'),
				width: getComputedStyle(document.querySelector('#meter span')).width,
				low: text('#usage-low'),
				reset: text('#usage-reset'),
			},
			settings: text('#settings'),
			mark: document.querySelector('.mark').naturalWidth,
			size: [innerWidth, innerHeight],
		};
	})()`);

const signedInParts = ['.wordmark', '#site', '#provider-title', '#fold-keys', '#settings'];
const proParts = ['.wordmark', '#usage', '#site', '#provider-title', '#fold-keys', '#settings'];
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const nbsp = String.fromCharCode(0xa0);

const readSettings = (page: Page) =>
	page.evaluate(() => {
		const text = (selector: string) => document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
		return {
			lang: document.documentElement.lang,
			title: document.title,
			heading: text('h1'),
			intro: text('#intro'),
			sections: [...document.querySelectorAll('h2')].map((h2) => h2.textContent),
			save: text('button[type="submit"]'),
			remove: text('#remove-key'),
			keyLabel: text('#key-label'),
			keyState: text('#key-state'),
			route: text('#route'),
			change: text('[data-change="fold"]'),
			noSites: text('#no-sites'),
		};
	});

async function hang(): Promise<{ baseUrl: string; requests: () => number; close(): Promise<void> }> {
	let count = 0;
	const server = http.createServer((request, response) => {
		const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
		if (request.method === 'OPTIONS') {
			response.writeHead(204, cors).end();
			return;
		}
		count++;
		if (count % 2 === 0) response.writeHead(500, cors).end('{}');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests: () => count,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

const darkPage = (page: Page) =>
	page.addStyleTag({
		content:
			'html,body,.mw-page-container,.vector-body,#content,.mw-body{background:#17171a!important;color:#e4e4e7!important}a{color:#8ab4f8!important}.vector-header-container,.vector-column-start,.vector-column-end{display:none!important}',
	});

test.describe('lanes', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	test('lane 1: signed in on the free plan, the toolbar icon opens a popup with the site switch, the provider and its key, the fold shortcut and a settings link, no usage meter, and the add-a-key button opens settings', async ({
		h,
	}) => {
		const noKeyPng = await fresh('p5e-popup-en-free-nokey');
		const lightPng = await fresh('p5e-popup-en-free-light');
		const darkPng = await fresh('p5e-popup-en-free-dark');
		await hintSeen(h);
		await h.navigate(fixtures.wiki);
		await ready(h);
		const popup = await h.openPopup();
		const noKey = await readPopup(popup);
		await popup.screenshot(noKeyPng);
		await saveKey(h);
		await expect.poll(async () => (await readPopup(popup)).provider.addKey).toBeNull();
		const keyed = await readPopup(popup);
		await popup.screenshot(lightPng);
		await popup.colorScheme('dark');
		await popup.screenshot(darkPng);
		await popup.close();

		await worker(h).evaluate(() => chrome.storage.local.remove('providers'));
		const again = await h.openPopup();
		const [settings] = await Promise.all([h.context.waitForEvent('page'), again.click('#add-key')]);
		await settings.waitForLoadState('load');
		await expect(settings.locator('#key')).toBeFocused();
		const settingsUrl = settings.url();

		const chromePage = await h.context.newPage();
		await chromePage.goto('chrome://version');
		const onChromePage = await h.openPopup(chromePage).then(async (popup) => {
			const state = await readPopup(popup);
			await popup.close();
			return state;
		});

		console.log(`no key: ${JSON.stringify(noKey)}`);
		console.log(`with a key: ${JSON.stringify(keyed)}`);
		console.log(`add a key opened ${settingsUrl}; on chrome://version: ${JSON.stringify(onChromePage.site)}`);
		const host = hostOf(h);
		expect(noKey).toMatchObject({
			lang: 'en',
			shown: signedInParts,
			site: { checked: 'true', disabled: false, title: 'Use on this site', host },
			provider: { title: 'Folding with quick summaries', state: 'Add an OpenGateway key and AI reads the whole paragraph to write its point', addKey: 'Add a key' },
			how: null,
			fold: 'Alt+Shift+↓',
			unfold: 'Alt+Shift+↑',
			scroll: 'Ctrl+scroll ↓ ↑',
			settings: 'Open settings',
		});
		expect(noKey.size[0]).toBe(320);
		expect(keyed.provider).toEqual({ title: 'AI summaries from OpenRouter', state: 'API key saved', addKey: null });
		expect(keyed.size[0]).toBe(320);
		expect(keyed.mark).toBeGreaterThan(0);
		expect(settingsUrl).toBe(optionsUrl(h));
		expect(onChromePage.site).toEqual({ checked: 'false', disabled: true, title: 'Use on this site', host: 'tfold cannot run on this page' });
		expect(errors(h)).toEqual([]);
	});

	test('lane 2: the popup switch turns tfold off for the site in every tab and restores Full, the toolbar shows off, and switching it on again folds', async ({ h }) => {
		await hintSeen(h);
		const host = hostOf(h);
		await h.navigate(fixtures.wiki);
		await ready(h);
		await foldBy(h, 1, 1);
		await foldBy(h, 3, 2);
		const [other] = await Promise.all([
			h.context.waitForEvent('page'),
			h.page.evaluate((url) => void window.open(url, 'tfold-other', 'popup,width=1000,height=700'), new URL(koWiki, h.baseURL).href),
		]);
		await other.waitForLoadState('load');
		const otherCdp = await h.context.newCDPSession(other);
		const otherFolds = () => other.evaluate(() => document.querySelectorAll('[data-tfold-overlay]').length);
		const foldOther = async () => {
			const point = await pointAt(other, otherCdp, nth(wikiParagraphs, 1));
			await foldAt(otherCdp, point.x, point.y, 1);
			await other.waitForTimeout(latchMs + 100);
			return otherFolds();
		};
		const before = { here: await folded(h), there: await foldOther(), toolbar: await toolbar(h) };

		const popup = await h.openPopup();
		await popup.click('#site');
		await expect.poll(() => folded(h)).toBe(0);
		await expect.poll(otherFolds).toBe(0);
		await expect.poll(async () => (await toolbar(h))?.badge).toBe('off');
		const off = {
			switch: (await readPopup(popup)).site.checked,
			toolbar: await toolbar(h),
			stored: await worker(h).evaluate(() => chrome.storage.local.get('disabledSites')),
		};
		await popup.close();
		await foldBy(h, 1, 1);
		await h.press('Alt+Shift+ArrowDown');
		const whileOff = { here: await folded(h), there: await foldOther() };

		const reopened = await h.openPopup();
		const shownOff = (await readPopup(reopened)).site.checked;
		await reopened.click('#site');
		await expect.poll(async () => (await toolbar(h))?.badge).toBe('');
		await reopened.close();
		await foldBy(h, 1, 1);
		const on = { here: await folded(h), there: await foldOther(), toolbar: await toolbar(h), stored: await worker(h).evaluate(() => chrome.storage.local.get('disabledSites')) };
		await other.close();

		console.log(`before ${JSON.stringify(before)}; off ${JSON.stringify(off)}; folds while off ${JSON.stringify(whileOff)}`);
		console.log(`the popup reopened showing ${shownOff}; on again ${JSON.stringify(on)}`);
		expect(before).toEqual({ here: 2, there: 1, toolbar: { badge: '', title: `tfold is on for ${host}` } });
		expect(off).toEqual({ switch: 'false', toolbar: { badge: 'off', title: `tfold is off for ${host}` }, stored: { disabledSites: [host] } });
		expect(whileOff).toEqual({ here: 0, there: 0 });
		expect(shownOff).toBe('false');
		expect(on).toEqual({ here: 1, there: 1, toolbar: { badge: '', title: `tfold is on for ${host}` }, stored: { disabledSites: [] } });
		expect(errors(h)).toEqual([]);
	});

	test('lane 3: in an English browser the name, the settings page, the hint on a Korean page, a failure badge and the toolbar speak English', async ({ h }) => {
		const lightPng = await fresh('p5e-settings-en-light');
		const darkPng = await fresh('p5e-settings-en-dark');
		const self = await worker(h).evaluate(() => chrome.management.getSelf().then(({ name, description }) => ({ name, description })));
		const settings = await h.context.newPage();
		await settings.setViewportSize({ width: 860, height: 900 });
		await settings.goto(optionsUrl(h));
		await expect(settings.locator('#route')).not.toBeEmpty();
		const page = await readSettings(settings);
		await settings.screenshot({ path: lightPng, fullPage: true, animations: 'disabled' });
		await settings.emulateMedia({ colorScheme: 'dark' });
		await settings.screenshot({ path: darkPng, fullPage: true, animations: 'disabled' });
		await settings.close();

		await hintSeen(h, false);
		await h.navigate(koWiki);
		await ready(h);
		await h.pointAt(nth(wikiParagraphs, 1));
		await expect(h.page.locator('tf-hint')).toHaveCount(1, { timeout: 4000 });
		const hint = await h.page.evaluate(() => document.querySelector('tf-hint')?.shadowRoot?.querySelector('div')?.textContent);
		await foldBy(h, 1, 1);
		await expect.poll(() => h.page.locator('[data-tf-badge]').count()).toBe(1);
		const badge = await h.page.locator('[data-tf-badge]').getAttribute('data-tf-badge');

		console.log(`manifest ${JSON.stringify(self)}; settings ${JSON.stringify(page)}`);
		console.log(`on Korean Wikipedia: hint ${JSON.stringify(hint)}, badge ${JSON.stringify(badge)}`);
		expect(self).toEqual({ name: 'tfold', description: 'Shortens the paragraph under your pointer, right on the page. Hold a key and scroll, or press a shortcut.' });
		expect(page).toMatchObject({
			lang: 'en',
			title: 'tfold settings',
			heading: 'Settings',
			sections: ['Try it here', 'AI summaries', 'Ways to fold', '언어 / Language', 'Sites where tfold is off', 'What tfold sends'],
			save: 'Save key',
			remove: 'Remove the OpenGateway key',
			keyLabel: 'OpenGateway API key',
			keyState: 'You need an OpenGateway account.',
			route: 'tfold folds with quick summaries now.',
			change: 'Change',
			noSites: 'None right now.',
		});
		expect(page.intro).toContain('A quick summary');
		expect(hint).toBe('Hold Ctrl and scroll down over a paragraph to shorten it, up to bring it back. Or press Alt+Shift+↓, Alt+Shift+↑');
		expect(badge).toBe('Add a key in tfold settings to get AI summaries');
		expect(errors(h)).toEqual([]);
	});

	test('lane 4: the manifest names PNG icons at 16, 32, 48 and 128 px, each file has its size, and the toolbar uses the 16 and 32 px ones', async ({ h }) => {
		const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8')) as {
			icons: Record<string, string>;
			action: { default_icon: Record<string, string> };
		};
		const sizeOf = async (file: string) => {
			const png = await readFile(path.join(extensionDir, file));
			return { png: png.subarray(1, 4).toString() === 'PNG', width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
		};
		const icons = Object.fromEntries(await Promise.all(Object.entries(manifest.icons).map(async ([size, file]) => [size, await sizeOf(file)] as const)));
		const self = await worker(h).evaluate(() => chrome.management.getSelf().then(({ icons }) => icons?.map(({ size }) => size)));

		console.log(`icons ${JSON.stringify(icons)}; toolbar ${JSON.stringify(manifest.action.default_icon)}; Chrome lists ${JSON.stringify(self)}`);
		expect(icons).toEqual(Object.fromEntries([16, 32, 48, 128].map((size) => [String(size), { png: true, width: size, height: size }])));
		expect(manifest.action.default_icon).toEqual({ '16': manifest.icons['16'], '32': manifest.icons['32'] });
		expect(self).toEqual([16, 32, 48, 128]);
	});

	test('lane 5: every text in the popup, the settings page, the hint and the failure badges meets WCAG AA contrast in light and dark', async ({ h }) => {
		const all: { where: string; pairs: Pair[] }[] = [];
		await hintSeen(h);
		await h.navigate(fixtures.wiki);
		await ready(h);
		const states = [
			{ name: 'signed out', account: { kind: 'signedOut' }, keyed: false },
			{ name: 'free without a key', account: { kind: 'free' }, keyed: false },
			{ name: 'free with a key', account: { kind: 'free' }, keyed: true },
			{ name: 'pro trial, 72% left', account: { kind: 'pro', trialEndsAt: inDays(5), remainingPercent: 72, resetsAt: inDays(20) }, keyed: true },
			{ name: 'pro trial ending, 8% left', account: { kind: 'pro', trialEndsAt: inDays(2), remainingPercent: 8, resetsAt: inDays(20) }, keyed: true },
			{ name: 'pro, 0% left', account: { kind: 'pro', remainingPercent: 0, resetsAt: inDays(20) }, keyed: true },
		];
		const popup = await h.openPopup();
		for (const { name, account, keyed } of states) {
			await worker(h).evaluate(
				async ({ account, keyed }) => {
					await chrome.storage.local.set({ account });
					if (keyed) await chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter: { apiKey: 'test-key' } } });
				},
				{ account, keyed },
			);
			await expect.poll(async () => (await readPopup(popup)).shown.includes('#signed-out')).toBe(account.kind === 'signedOut');
			await expect.poll(async () => (await readPopup(popup)).provider.addKey === null).toBe(keyed || account.kind === 'signedOut');
			for (const scheme of ['light', 'dark'] as const) {
				await popup.colorScheme(scheme);
				all.push({ where: `popup ${name}, ${scheme}`, pairs: await popup.evaluate<Pair[]>(contrastProbe) });
			}
		}
		await popup.close();

		await worker(h).evaluate((host) => chrome.storage.local.set({ account: { kind: 'free' }, disabledSites: [host] }), hostOf(h));
		const keyAnswer = { status: 200 };
		await h.context.route('https://openrouter.ai/api/v1/key', (route) => route.fulfill({ status: keyAnswer.status, body: '{"data":{"label":"mock"}}' }));
		await worker(h).evaluate(() => chrome.storage.local.set({ providers: { chosen: 'openrouter' } }));
		const settings = await h.context.newPage();
		await settings.goto(optionsUrl(h));
		await expect(settings.locator('#sites li')).toHaveCount(1);
		await settings.locator('#advanced > summary').click();
		await settings.locator('[data-change="fold"]').click();
		await expect(settings.locator('#keys-status')).not.toBeEmpty();
		for (const [tone, status] of [['error', 401], ['caution', 503], ['success', 200]] as const) {
			keyAnswer.status = status;
			await settings.locator('#key').fill('typed-key');
			await settings.locator('button[type="submit"]').click();
			await expect(settings.locator('#status')).toHaveAttribute('data-tone', tone);
			for (const scheme of ['light', 'dark'] as const) {
				await settings.emulateMedia({ colorScheme: scheme });
				all.push({ where: `settings, ${tone} status, ${scheme}`, pairs: await settings.evaluate<Pair[]>(contrastProbe) });
			}
		}
		await settings.locator('#remove-key').click();
		await expect(settings.locator('#undo')).toBeVisible();
		await settings.locator('#key').fill('typed-key');
		for (const scheme of ['light', 'dark'] as const) {
			await settings.emulateMedia({ colorScheme: scheme });
			all.push({ where: `settings, undo offered with a typed key, ${scheme}`, pairs: await settings.evaluate<Pair[]>(contrastProbe) });
		}
		await settings.close();
		await worker(h).evaluate(() => chrome.storage.local.set({ disabledSites: [], hintSeen: false }));

		const mock = await hang();
		try {
			await saveKey(h, mock.baseUrl);
			for (const page of ['light', 'dark'] as const) {
				await hintSeen(h, false);
				await h.navigate(fixtures.wiki);
				await ready(h);
				if (page === 'dark') await darkPage(h.page);
				await h.pointAt(nth(wikiParagraphs, 4));
				await expect(h.page.locator('tf-hint')).toHaveCount(1, { timeout: 4000 });
				const hint = await h.page.evaluate<Pair[]>(contrastProbe);
				await foldBy(h, 4, 1);
				await expect.poll(() => h.page.locator('[data-tf-badge]').count(), { timeout: 15_000 }).toBeGreaterThan(0);
				const badge = await h.page.evaluate<Pair[]>(contrastProbe);
				const ours = (pairs: Pair[], texts: string[]) => pairs.filter((pair) => texts.some((text) => pair.text.startsWith(text)));
				all.push({ where: `in-page hint and badge, ${page} page`, pairs: [...ours(hint, ['Hold ', 'Alt+Shift']), ...ours(badge, ['AI summary failed', 'Network error'])] });
			}
		} finally {
			await mock.close();
		}

		for (const { where, pairs } of all) {
			console.log(`${where}: ${pairsOf(pairs).map((pair) => `${pair.fg} on ${pair.bg} ${pair.ratio}:1 (${pair.text})`).join('; ')}`);
		}
		const failing = all.flatMap(({ where, pairs }) => pairs.filter((pair) => pair.ratio < (pair.size >= 24 ? 3 : 4.5)).map((pair) => ({ where, ...pair })));
		expect(all.map(({ where, pairs }) => [where, pairs.length >= 2])).toEqual(all.map(({ where }) => [where, true]));
		expect(all.filter(({ where }) => where.startsWith('in-page')).every(({ pairs }) => pairs.length >= 3)).toBe(true);
		expect(failing).toEqual([]);
	});

	test('lane 6: the hint, the waiting rail and a failure badge on a light page and on a dark one', async ({ h }) => {
		const mock = await hang();
		const seen: Record<string, unknown> = {};
		const boxOf = (index: number) =>
			h.page.evaluate(
				({ selector, index }) => {
					const el = document.querySelectorAll(selector)[index];
					const box = (el?.checkVisibility() ? el : el?.nextElementSibling)?.getBoundingClientRect();
					return { top: box?.top ?? 0, bottom: box?.bottom ?? 0 };
				},
				{ selector: wikiParagraphs, index },
			);
		const clip = async (top: number, bottom: number, file: string) => {
			await h.page.screenshot({
				path: file,
				clip: { x: 0, y: Math.max(0, top - 32), width: 1100, height: Math.min(700, bottom - top + 64) },
				animations: 'disabled',
			});
		};
		try {
			await saveKey(h, mock.baseUrl);
			await h.page.setViewportSize({ width: 1100, height: 760 });
			for (const theme of ['light', 'dark'] as const) {
				const hintPng = await fresh(`p5e-hint-${theme}`);
				const foldPng = await fresh(`p5e-fold-${theme}`);
				await hintSeen(h, false);
				await h.navigate(fixtures.wiki);
				await ready(h);
				if (theme === 'dark') await darkPage(h.page);
				const [last, first] = await h.page.evaluate((selector) => {
					const all = [...document.querySelectorAll(selector)];
					const long = (el: Element) => (el.textContent ?? '').length > 250 && el.querySelector('img, table') === null;
					const at = all.findIndex((el, i) => i > 0 && all[i + 1] !== undefined && el.closest('section') !== all[i + 1]?.closest('section') && long(el) && long(all[i + 1] as Element));
					return [at, at + 1];
				}, wikiParagraphs);
				await h.page.locator(nth(wikiParagraphs, last)).evaluate((el) => el.scrollIntoView({ block: 'center' }));
				await h.pointAt(nth(wikiParagraphs, last));
				await expect(h.page.locator('tf-hint')).toHaveCount(1, { timeout: 4000 });
				await h.page.waitForTimeout(400);
				const hintTop = await h.page.evaluate(() => document.querySelector('tf-hint')?.shadowRoot?.querySelector('div')?.getBoundingClientRect().top ?? 0);
				await clip(hintTop, (await boxOf(last)).bottom, hintPng);

				await foldBy(h, last, 1);
				await foldBy(h, first, 1);
				await expect.poll(() => h.page.locator('[data-tf-badge]').count()).toBe(1);
				const pending = await h.page.locator('[data-tf-pending]').count();
				await h.page.mouse.move(1090, 10);
				await h.page.waitForTimeout(500);
				await clip((await boxOf(last)).top, (await boxOf(first)).bottom, foldPng);
				seen[theme] = { paragraphs: [last, first], pending, badge: await h.page.locator('[data-tf-badge]').getAttribute('data-tf-badge') };
			}
		} finally {
			await mock.close();
		}
		console.log(JSON.stringify(seen));
		expect(seen).toEqual({
			light: { paragraphs: expect.any(Array) as unknown, pending: 1, badge: 'AI summary failed · try again' },
			dark: { paragraphs: expect.any(Array) as unknown, pending: 1, badge: 'AI summary failed · try again' },
		});
		expect(errors(h)).toEqual([]);
	});
});

inKorean('lane 7: in a Korean browser the name, the popup, the settings page, the hint on an English page, a failure badge and the toolbar speak Korean', async ({ h }) => {
	const shots = {
		popupLight: await fresh('p5e-popup-ko-free-light'),
		popupDark: await fresh('p5e-popup-ko-free-dark'),
		popupNoKey: await fresh('p5e-popup-ko-free-nokey'),
		settingsLight: await fresh('p5e-settings-ko-light'),
		settingsDark: await fresh('p5e-settings-ko-dark'),
	};
	const host = hostOf(h);
	const self = await worker(h).evaluate(() => chrome.management.getSelf().then(({ name, description }) => ({ name, description })));
	await hintSeen(h, false);
	await h.navigate(fixtures.wiki);
	await ready(h);
	await h.pointAt(nth(wikiParagraphs, 1));
	await expect(h.page.locator('tf-hint')).toHaveCount(1, { timeout: 4000 });
	const hint = await h.page.evaluate(() => document.querySelector('tf-hint')?.shadowRoot?.querySelector('div')?.textContent);
	await foldBy(h, 1, 1);
	await expect.poll(() => h.page.locator('[data-tf-badge]').count()).toBe(1);
	const badge = await h.page.locator('[data-tf-badge]').getAttribute('data-tf-badge');

	const popup = await h.openPopup();
	const noKey = await readPopup(popup);
	await popup.screenshot(shots.popupNoKey);
	await saveKey(h);
	await expect.poll(async () => (await readPopup(popup)).provider.addKey).toBeNull();
	const keyed = await readPopup(popup);
	await popup.screenshot(shots.popupLight);
	await popup.colorScheme('dark');
	await popup.screenshot(shots.popupDark);
	await popup.click('#site');
	await expect.poll(async () => (await toolbar(h))?.badge).toBe('꺼짐');
	const off = await toolbar(h);
	await popup.close();

	const settings = await h.context.newPage();
	await settings.setViewportSize({ width: 860, height: 900 });
	await settings.goto(optionsUrl(h));
	await expect(settings.locator('#sites li')).toHaveCount(1);
	const page = await readSettings(settings);
	await settings.screenshot({ path: shots.settingsLight, fullPage: true, animations: 'disabled' });
	await settings.emulateMedia({ colorScheme: 'dark' });
	await settings.screenshot({ path: shots.settingsDark, fullPage: true, animations: 'disabled' });
	const turnOn = await settings.locator('#sites li button').getAttribute('aria-label');
	await settings.close();

	console.log(`manifest ${JSON.stringify(self)}; on English Wikipedia: hint ${JSON.stringify(hint)}, badge ${JSON.stringify(badge)}`);
	console.log(`popup without a key ${JSON.stringify(noKey)}; with a key ${JSON.stringify(keyed.provider)}; toolbar when off ${JSON.stringify(off)}`);
	console.log(`settings ${JSON.stringify(page)}; turn-on button ${JSON.stringify(turnOn)}`);
	expect(self).toEqual({ name: 'tfold', description: '읽고 있는 문단을 그 자리에서 짧게 줄여 줘요. 키를 누른 채 스크롤하거나 단축키를 누르세요.' });
	expect(hint).toBe('Ctrl 키를 누른 채 문단 위에서 아래로 스크롤하면 접히고, 위로 스크롤하면 펼쳐져요. 단축키는 Alt+Shift+↓, Alt+Shift+↑');
	expect(badge).toBe('AI 요약을 받으려면 tfold 설정에서 키를 넣어 주세요');
	expect(noKey).toMatchObject({
		lang: 'ko',
		shown: signedInParts,
		site: { checked: 'true', title: '이 사이트에서 사용', host },
		provider: { title: '빠른 요약으로 접고 있어요', state: 'OpenGateway 키를 넣으면 AI가 문단 전체를 읽고 핵심을 써 줘요', addKey: '키 넣기' },
		how: null,
		fold: 'Alt+Shift+↓',
		unfold: 'Alt+Shift+↑',
		scroll: 'Ctrl+스크롤 ↓ ↑',
		settings: '설정 열기',
	});
	expect(keyed.provider).toEqual({ title: 'OpenRouter에서 AI 요약을 받아요', state: '키가 저장돼 있어요', addKey: null });
	expect(off).toEqual({ badge: '꺼짐', title: `${host}에서 tfold가 꺼져 있어요` });
	expect(page).toMatchObject({
		lang: 'ko',
		title: 'tfold 설정',
		heading: '설정',
		sections: ['여기서 접어 보기', 'AI 요약', '접는 방법', '언어 / Language', 'tfold를 끈 사이트', 'tfold가 보내는 것'],
		save: '키 저장',
		remove: 'OpenRouter 키 지우기',
		keyLabel: 'OpenRouter API 키',
		keyState: '키가 저장돼 있어요. 바꾸려면 새 키를 넣으세요.',
		route: 'OpenRouter에서 AI 요약을 받아요.',
		change: '바꾸기',
	});
	expect(page.intro).toContain('빠른 요약은');
	expect(turnOn).toBe(`${host}에서 tfold 다시 켜기`);
	expect(errors(h)).toEqual([]);
});

test('lane 8: a new install is signed out, so the popup shows only the wordmark, one line and Continue with Google, which opens the sign-in page on the website, and folding, the hint and the shortcut stay off until an account is stored, then work without a reload', async ({
	headless,
}) => {
	const seen: Record<string, unknown> = {};
	for (const lang of ['en', 'ko'] as const) {
		const lightPng = await fresh(`p5e-popup-${lang}-signedout-light`);
		const darkPng = await fresh(`p5e-popup-${lang}-signedout-dark`);
		const h = await launch({ headless, lang, account: null });
		try {
			const stored = await worker(h).evaluate(() => chrome.storage.local.get('account'));
			await hintSeen(h, false);
			await h.navigate(fixtures.wiki);
			await ready(h);
			await h.pointAt(nth(wikiParagraphs, 1));
			await h.page.waitForTimeout(2500);
			const hints = await h.page.locator('tf-hint').count();
			await foldBy(h, 1, 1);
			await h.press('Alt+Shift+ArrowDown');
			const foldedOut = await folded(h);
			const toolbarOut = await toolbar(h);
			const popup = await h.openPopup();
			const state = await readPopup(popup);
			await popup.screenshot(lightPng);
			await popup.colorScheme('dark');
			await popup.screenshot(darkPng);
			await h.context.route(signInUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<title>tfold sign-in</title>' }));
			await popup.click('#continue');
			await expect.poll(() => h.tabUrls()).toContain(signInUrl);

			await worker(h).evaluate(() => chrome.storage.local.set({ account: { kind: 'free' } }));
			await h.page.bringToFront();
			await expect.poll(async () => (await toolbar(h))?.title).not.toBe(toolbarOut?.title);
			await foldBy(h, 1, 1);
			seen[lang] = { stored, hints, foldedOut, toolbarOut, state, foldedIn: await folded(h), toolbarIn: await toolbar(h) };
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	}

	console.log(JSON.stringify(seen, null, 1));
	const host = '127.0.0.1';
	const signedOut = { shown: ['.wordmark', '#signed-out'], site: { title: null }, provider: { title: null }, usage: { left: null }, settings: null };
	expect(seen.en).toMatchObject({
		stored: {},
		hints: 0,
		foldedOut: 0,
		toolbarOut: { badge: '', title: 'Sign in to start using tfold' },
		state: { lang: 'en', ...signedOut, signedOut: { text: 'tfold shortens the paragraph you are reading, right where it is.', button: 'Continue with Google' } },
		foldedIn: 1,
		toolbarIn: { badge: '', title: `tfold is on for ${host}` },
	});
	expect(seen.ko).toMatchObject({
		stored: {},
		hints: 0,
		foldedOut: 0,
		toolbarOut: { badge: '', title: '로그인하면 tfold를 쓸 수 있어요' },
		state: { lang: 'ko', ...signedOut, signedOut: { text: '읽던 문단을 그 자리에서 짧게 접어 줘요.', button: 'Google로 계속하기' } },
		foldedIn: 1,
		toolbarIn: { badge: '', title: `${host}에서 tfold가 켜져 있어요` },
	});
});

test('lane 9: on Pro the popup shows the share of this month left on a meter under the wordmark with the reset date and the trial days left, warns at 10% or less, and at 0% says once that it folds with quick summaries, in English and Korean', async ({
	headless,
}) => {
	const seen: Record<string, Record<string, PopupState>> = {};
	const resetsAt = '2026-12-01T12:00:00.000Z';
	for (const lang of ['en', 'ko'] as const) {
		const h = await launch({ headless, lang, account: null });
		seen[lang] = {};
		try {
			await saveKey(h);
			await h.navigate(fixtures.wiki);
			await ready(h);
			const steps = [
				{ name: '72', account: { kind: 'pro', trialEndsAt: inDays(4), remainingPercent: 72, resetsAt } },
				{ name: '8', account: { kind: 'pro', trialEndsAt: inDays(1), remainingPercent: 8, resetsAt } },
				{ name: '0', account: { kind: 'pro', remainingPercent: 0, resetsAt } },
			];
			const popup = await h.openPopup();
			for (const { name, account } of steps) {
				await worker(h).evaluate((account) => chrome.storage.local.set({ account }), account);
				await expect.poll(async () => (await readPopup(popup)).usage.value).toBe(String(account.remainingPercent));
				seen[lang][name] = await readPopup(popup);
				await popup.colorScheme('light');
				await popup.screenshot(await fresh(`p5e-popup-${lang}-pro-${name}-light`));
				await popup.colorScheme('dark');
				await popup.screenshot(await fresh(`p5e-popup-${lang}-pro-${name}-dark`));
			}
			await worker(h).evaluate(() => chrome.storage.local.set({ account: { kind: 'free' } }));
			await expect.poll(async () => (await readPopup(popup)).shown).toEqual(signedInParts);
			await popup.close();
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	}

	console.log(JSON.stringify(seen, null, 1));
	const usage = (lang: 'en' | 'ko', name: string) => seen[lang]?.[name]?.usage;
	expect(seen.en?.['72']?.shown).toEqual(proParts);
	const resetEn = `Resets Dec${nbsp}1`;
	const resetKo = `12월${nbsp}1일에 다시 채워져요`;
	expect(usage('en', '72')).toEqual({ left: '72% left this month', trial: '4 days left in trial', value: '72', width: expect.stringMatching(/px$/) as unknown, low: null, reset: resetEn });
	expect(usage('en', '8')).toMatchObject({ left: '8% left this month', trial: 'Trial ends tomorrow', value: '8', low: 'Almost out of AI summaries', reset: resetEn });
	expect(usage('en', '0')).toMatchObject({ left: '0% left this month', trial: null, value: '0', width: '0px', low: null, reset: resetEn });
	expect(seen.en?.['0']?.settings).toBe('Open settings');
	expect(usage('ko', '72')).toMatchObject({ left: '이번 달 남은 사용량 72%', trial: '체험 4일 남음', value: '72', low: null, reset: resetKo });
	expect(usage('ko', '8')).toMatchObject({ left: '이번 달 남은 사용량 8%', trial: '체험이 내일 끝나요', low: 'AI 요약이 얼마 안 남았어요', reset: resetKo });
	expect(usage('ko', '0')).toMatchObject({ left: '이번 달 남은 사용량 0%', trial: null, low: null, reset: resetKo });
	expect(seen.en?.['72']?.provider).toEqual({ title: 'AI summaries with your Pro plan', state: null, addKey: null });
	expect(seen.ko?.['72']?.provider).toEqual({ title: 'Pro 요금제로 AI 요약을 받아요', state: null, addKey: null });
	expect(seen.en?.['0']?.provider).toEqual({ title: 'Using quick summaries for now', state: null, addKey: null });
	expect(seen.ko?.['0']?.provider).toEqual({ title: '지금은 빠른 요약으로 접어요', state: null, addKey: null });
	const widths = ['72', '8'].map((name) => parseFloat(usage('en', name)?.width ?? '0'));
	expect(widths[0]).toBeGreaterThan(8 * (widths[1] ?? 0));
});

test('lane 10: the store build has no development account controls and its worker refuses them, and a development build sets the account from settings', async ({
	h,
	headless,
}) => {
	const png = await fresh('p5e-settings-dev');
	const settings = await h.context.newPage();
	await settings.goto(optionsUrl(h));
	await expect(settings.locator('#route')).not.toBeEmpty();
	const store = {
		section: await settings.locator('#dev-account').count(),
		refused: await settings.evaluate(() => chrome.runtime.sendMessage<unknown, boolean>({ type: 'set-account', account: { kind: 'pro' } })),
		stored: await worker(h).evaluate(() => chrome.storage.local.get('account')),
		bundled: (await readFile(path.join(extensionDir, 'options', 'options.js'), 'utf8')).includes('Development build'),
	};
	await settings.close();

	const devDir = path.join(outDir, 'dist-dev');
	const built = spawnSync('node', ['scripts/build.ts', '--dev', '--outdir', devDir], { cwd: repoRoot, encoding: 'utf8' });
	expect(built.status, built.stderr).toBe(0);
	const dev = await launch({ headless, account: null }, devDir);
	try {
		await dev.navigate(fixtures.wiki);
		await ready(dev);
		await foldBy(dev, 1, 1);
		const before = await folded(dev);
		const options = await dev.context.newPage();
		await options.setViewportSize({ width: 860, height: 900 });
		await options.goto(`chrome-extension://${dev.extensionId}/options/options.html`);
		await options.locator('#dev-account [data-account="free"]').click();
		await expect(options.locator('#dev-account [data-account="free"]')).toHaveAttribute('aria-pressed', 'true');
		await options.locator('#dev-account').screenshot({ path: png });
		const stored = await worker(dev).evaluate(() => chrome.storage.local.get('account'));
		await options.close();
		await dev.page.bringToFront();
		await foldBy(dev, 1, 1);
		const after = await folded(dev);

		console.log(`store build ${JSON.stringify(store)}; development build folded ${before} signed out, ${after} after Free, stored ${JSON.stringify(stored)}`);
		expect(store).toEqual({ section: 0, refused: false, stored: { account: { kind: 'free' } }, bundled: false });
		expect([before, after]).toEqual([0, 1]);
		expect(stored).toEqual({ account: { kind: 'free' } });
		expect(errors(dev)).toEqual([]);
	} finally {
		await dev.close();
	}
});

type LoadSeen = { folds: number; presses: number; first: number; ready: number };

const watchFolds = () => {
	const seen: LoadSeen = { folds: 0, presses: 0, first: 0, ready: 0 };
	new MutationObserver((records) => {
		seen.folds += records.filter((record) => record.oldValue === null).length;
	}).observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-tfold-hidden'] });
	addEventListener(
		'keydown',
		(event) => {
			if (event.key !== 'ArrowDown') return;
			seen.presses++;
			seen.first ||= Math.round(performance.now());
		},
		true,
	);
	addEventListener('DOMContentLoaded', () => (seen.ready = Math.round(performance.now())));
	Object.defineProperty(window, '__p5e', { get: () => seen });
};

const [alt, ctrl, shift] = [1, 2, 8];
const arrowDown = { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: alt | shift };

async function pressWhileLoading(h: Harness, at: { x: number; y: number }): Promise<LoadSeen> {
	const cdp = await h.context.newCDPSession(h.page);
	await h.page.goto(new URL(fixtures.wiki, h.baseURL).href, { waitUntil: 'commit' });
	let loadedAt = Number.POSITIVE_INFINITY;
	void h.page.waitForLoadState('load').then(() => (loadedAt = Date.now()));
	const giveUp = Date.now() + 15_000;
	for (let i = 0; Date.now() < Math.min(loadedAt + 800, giveUp); i++) {
		const point = { x: at.x + (i % 2), y: at.y };
		const wheel = Array.from({ length: i % 8 === 0 ? 6 : 0 }, () =>
			cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 10, modifiers: ctrl }),
		);
		await Promise.all([
			cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }),
			cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...arrowDown }),
			cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...arrowDown }),
			...wheel,
		]);
	}
	await cdp.detach();
	await h.page.waitForTimeout(latchMs + 100);
	return h.page.evaluate(() => (window as unknown as { __p5e: LoadSeen }).__p5e);
}

test('lane 11: signed out, the fold shortcut and a fold pressed again and again while each page loads never fold and never reach the provider, the worker refuses a fold asked for directly, and once an account is stored the same presses fold', async ({
	headless,
}) => {
	test.setTimeout(300_000);
	const loads = 20;
	const mock = await hang();
	const h = await launch({ headless, account: null, allowLiveHosts: ['127.0.0.1'] });
	try {
		await saveKey(h, mock.baseUrl);
		await hintSeen(h);
		await h.context.addInitScript(watchFolds);
		await h.navigate(fixtures.wiki);
		await ready(h);
		const at = await h.page.evaluate((selector) => {
			for (const el of document.querySelectorAll(selector)) {
				const box = el.getBoundingClientRect();
				const point = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + Math.min(box.height, 60) / 2) };
				if (box.top >= 0 && box.bottom <= innerHeight && el.contains(document.elementFromPoint(point.x, point.y))) return point;
			}
			return null;
		}, wikiParagraphs);
		if (!at) throw new Error('no paragraph sits fully inside the first screen');

		const signedOut = [];
		for (let load = 0; load < loads; load++) signedOut.push(await pressWhileLoading(h, at));
		const requestsFromPresses = mock.requests();
		const asked = await h.inContent<unknown>(`chrome.runtime.sendMessage({
			type: 'fold',
			request: { url: location.href, title: document.title, lang: 'en', outline: [], section: 0, blocks: [{ id: 'p5e', tag: 'p', sentences: ['A star collapses.', 'Light cannot escape.'] }] },
		})`);
		const requestsSignedOut = mock.requests();

		await worker(h).evaluate(() => chrome.storage.local.set({ account: { kind: 'free' } }));
		const signedIn = await pressWhileLoading(h, at);
		await expect.poll(() => mock.requests(), { timeout: 5000 }).toBeGreaterThan(requestsSignedOut);

		console.log(`signed out, per load: ${signedOut.map(({ folds, presses, first, ready }) => `${folds} folds of ${presses} presses from ${first} ms, DOM ready at ${ready} ms`).join('; ')}`);
		console.log(`signed out: ${requestsFromPresses} provider requests from presses, a direct fold got ${JSON.stringify(asked)}, ${requestsSignedOut} requests in all`);
		console.log(`signed in, one load: ${signedIn.folds} folds of ${signedIn.presses} presses, ${mock.requests()} provider requests`);
		expect({ folds: signedOut.map(({ folds }) => folds), requestsFromPresses, asked, requestsSignedOut }).toEqual({
			folds: Array.from({ length: loads }, () => 0),
			requestsFromPresses: 0,
			asked: { ok: false, error: 'failed' },
			requestsSignedOut: 0,
		});
		expect(signedOut.every(({ presses }) => presses > 20)).toBe(true);
		expect(signedIn.folds).toBeGreaterThan(0);
		expect(errors(h)).toEqual([]);
	} finally {
		await h.close();
		await mock.close();
	}
});

inKorean('lane 12: on an English page in a 320 px window, the Korean hint stays inside the window and it and the failure badge in a 252 px column wrap only between words', async ({ h }) => {
	const png = await fresh('p5e-badge-ko-narrow');
	await h.page.setViewportSize({ width: 320, height: 720 });
	await hintSeen(h, false);
	await h.navigate(fixtures.wiki);
	await ready(h);
	await h.page.addStyleTag({ content: '#mw-content-text section > p{max-width:252px!important}' });
	await h.pointAt(nth(wikiParagraphs, 1));
	await expect(h.page.locator('tf-hint')).toHaveCount(1, { timeout: 4000 });
	await h.page.waitForTimeout(300);
	const hint = await h.page.evaluate(() => {
		const tip = document.querySelector('tf-hint')?.shadowRoot?.querySelector('div');
		if (!tip) return null;
		const box = tip.getBoundingClientRect();
		return { text: tip.textContent, left: box.left >= 0, right: box.right <= innerWidth, wordBreak: getComputedStyle(tip).wordBreak };
	});
	await foldBy(h, 1, 1);
	await expect.poll(() => h.page.locator('[data-tf-badge]').count()).toBe(1);
	const badge = await h.page.locator('[data-tf-badge]').evaluate((overlay) => {
		const after = getComputedStyle(overlay, '::after');
		return { text: overlay.getAttribute('data-tf-badge'), column: Math.round(overlay.getBoundingClientRect().width), wordBreak: after.wordBreak };
	});
	await h.page.locator('[data-tf-badge]').screenshot({ path: png, animations: 'disabled' });

	console.log(`hint ${JSON.stringify(hint)}; badge ${JSON.stringify(badge)}`);
	expect(hint).toEqual({ text: 'Ctrl 키를 누른 채 문단 위에서 아래로 스크롤하면 접히고, 위로 스크롤하면 펼쳐져요. 단축키는 Alt+Shift+↓, Alt+Shift+↑', left: true, right: true, wordBreak: 'keep-all' });
	expect(badge).toEqual({ text: 'AI 요약을 받으려면 tfold 설정에서 키를 넣어 주세요', column: expect.any(Number) as unknown, wordBreak: 'keep-all' });
	expect(badge.column).toBeLessThanOrEqual(252);
	expect(errors(h)).toEqual([]);
});

const lineProbe = `(() => {
	const linesOf = (el) => {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const words = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			for (const match of node.textContent.matchAll(/[^ \\n\\t]+/g)) {
				const range = document.createRange();
				range.setStart(node, match.index);
				range.setEnd(node, match.index + match[0].length);
				const rects = [...range.getClientRects()];
				if (rects.length > 0) words.push({ word: match[0], top: Math.round(rects.at(-1).top) });
			}
		}
		const tops = [...new Set(words.map(({ top }) => top))];
		return { words, tops };
	};
	return ['#usage-left', '#usage-low', '#usage-reset', '#trial-left', '#site-title', '#site-error', '#provider-title', '#provider-state', '#how-title']
		.map((selector) => document.querySelector(selector))
		.filter((el) => el?.checkVisibility())
		.map((el) => {
			const { words, tops } = linesOf(el);
			const last = words.filter(({ top }) => top === tops.at(-1));
			return { id: el.id || el.dataset.i18n, text: el.textContent.trim(), lines: tops.length, orphan: tops.length > 1 && last.length === 1 };
		});
})()`;

const fitProbe = `(() => ({
	height: Math.ceil(document.body.getBoundingClientRect().height),
	width: Math.ceil(document.body.getBoundingClientRect().width),
	spilled: [...document.querySelectorAll('kbd, .row-title, .row-hint, .button')].filter((el) => el.checkVisibility() && el.getBoundingClientRect().right > document.body.getBoundingClientRect().right - 20).map((el) => el.textContent),
}))()`;

const meterProbe = `(() => {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 1;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	const rgb = (css) => {
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = css;
		ctx.fillRect(0, 0, 1, 1);
		return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
	};
	const luminance = (color) => {
		const [r, g, b] = color.map((value) => {
			const c = value / 255;
			return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const ratio = (a, b) => {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
	};
	const bar = rgb(getComputedStyle(document.querySelector('#meter span')).backgroundColor);
	const track = rgb(getComputedStyle(document.getElementById('meter')).backgroundColor);
	const left = getComputedStyle(document.getElementById('usage-left'));
	return { ratio: ratio(bar, track), weight: Number(left.fontWeight), color: left.color };
})()`;

type Line = { id: string; text: string; lines: number; orphan: boolean };
type Meter = { ratio: number; weight: number; color: string };
type Fit = { height: number; width: number; spilled: string[] };

test('lane 13: every state of the usage meter reads at both themes and both languages, with stronger emphasis at 10% or less, a bar that shows against its track, and no orphaned word', async ({ headless }) => {
	test.setTimeout(180_000);
	const seen: Record<string, { meter: Meter; lines: Line[]; low: string | null; reset: string | null }> = {};
	for (const lang of ['en', 'ko'] as const) {
		const h = await launch({ headless, lang, account: null });
		try {
			await h.navigate(fixtures.wiki);
			await ready(h);
			const popup = await h.openPopup();
			for (const percent of [72, 11, 10, 8, 1, 0]) {
				await worker(h).evaluate(
					(account) => chrome.storage.local.set({ account }),
					{ kind: 'pro', trialEndsAt: inDays(5), remainingPercent: percent, resetsAt: '2026-12-01T12:00:00.000Z' },
				);
				await expect.poll(async () => (await readPopup(popup)).usage.value).toBe(String(percent));
				for (const scheme of ['light', 'dark'] as const) {
					await popup.colorScheme(scheme);
					const state = await readPopup(popup);
					seen[`${lang} ${percent} ${scheme}`] = {
						meter: await popup.evaluate<Meter>(meterProbe),
						lines: await popup.evaluate<Line[]>(lineProbe),
						low: state.usage.low,
						reset: state.usage.reset,
					};
					await popup.screenshot(await fresh(`p5e-usage-${lang}-${percent}-${scheme}`));
				}
			}
			await popup.close();
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	}
	console.log(JSON.stringify(seen, null, 1));
	for (const [where, { meter, lines, low, reset }] of Object.entries(seen)) {
		const percent = Number(where.split(' ')[1]);
		expect(reset, where).not.toBeNull();
		expect(low !== null, where).toBe(percent > 0 && percent <= 10);
		expect(meter.ratio, `${where}: bar against track`).toBeGreaterThanOrEqual(3);
		expect(meter.weight, where).toBe(percent <= 10 ? 700 : 500);
		expect(lines.filter(({ orphan }) => orphan), where).toEqual([]);
		if (percent === 0) expect(lines.filter(({ id, lines }) => id === 'provider-title' && lines > 1), where).toEqual([]);
	}
	for (const scheme of ['light', 'dark']) expect(seen[`en 8 ${scheme}`]?.meter.color).not.toBe(seen[`en 72 ${scheme}`]?.meter.color);
});

test('lane 14: the trial line keeps its words and turns stronger in the last 3 days', async ({ h }) => {
	const seen: Record<string, { text: string | null; weight: string; color: string; urgent: boolean }> = {};
	await h.navigate(fixtures.wiki);
	await ready(h);
	const popup = await h.openPopup();
	for (const days of [7, 4, 3, 2, 1]) {
		const noon = new Date();
		noon.setHours(12, 0, 0, 0);
		noon.setDate(noon.getDate() + days);
		await worker(h).evaluate((account) => chrome.storage.local.set({ account }), { kind: 'pro', trialEndsAt: noon.toISOString(), remainingPercent: 72, resetsAt: inDays(20) });
		await expect.poll(async () => (await readPopup(popup)).usage.trial).not.toBeNull();
		await popup.evaluate('new Promise((resolve) => setTimeout(resolve, 100))');
		seen[String(days)] = await popup.evaluate(`(() => {
			const el = document.getElementById('trial-left');
			const style = getComputedStyle(el);
			return { text: el.textContent, weight: style.fontWeight, color: style.color, urgent: el.classList.contains('urgent') };
		})()`);
		await popup.screenshot(await fresh(`p5e-trial-${days}`));
	}
	await popup.close();
	console.log(JSON.stringify(seen));
	expect(Object.entries(seen).map(([days, { urgent }]) => [days, urgent])).toEqual(expect.arrayContaining([['7', false], ['4', false], ['3', true], ['2', true], ['1', true]]));
	expect(seen['7']?.weight).toBe('400');
	expect(seen['3']?.weight).toBe('700');
	expect(seen['3']?.color).not.toBe(seen['7']?.color);
	expect(errors(h)).toEqual([]);
});

test('lane 15: the usage card reads the share left once to a screen reader', async ({ h }) => {
	await worker(h).evaluate((account) => chrome.storage.local.set({ account }), { kind: 'pro', trialEndsAt: inDays(5), remainingPercent: 72, resetsAt: inDays(20) });
	const page = await h.context.newPage();
	await page.goto(`chrome-extension://${h.extensionId}/popup/popup.html`);
	await expect(page.locator('#meter')).toHaveAttribute('aria-valuenow', '72');
	const snapshot = await page.locator('#usage').ariaSnapshot();
	console.log(snapshot);
	expect(snapshot.match(/72/g)?.length ?? 0).toBeLessThanOrEqual(1);
	expect(snapshot).toContain('meter "Usage left this month"');
	expect(await page.locator('#usage').evaluate((el) => [el.localName, el.getAttribute('aria-labelledby')])).toEqual(['div', null]);
	await page.close();
});

test('lane 16: a site switch that cannot save goes back and says so, in both languages and both themes', async ({ headless }) => {
	const seen: Record<string, unknown> = {};
	for (const lang of ['en', 'ko'] as const) {
		const h = await launch({ headless, lang });
		try {
			await h.navigate(fixtures.wiki);
			await ready(h);
			const popup = await h.openPopup();
			const before = await popup.evaluate<string>(`document.getElementById('site').getAttribute('aria-checked')`);
			await popup.evaluate(`Object.defineProperty(chrome.runtime, 'sendMessage', { value: () => Promise.reject(new Error('worker gone')) })`);
			await popup.click('#site');
			await popup.evaluate(`new Promise((resolve) => setTimeout(resolve, 100))`);
			const after = await popup.evaluate<Record<string, string | boolean | null>>(`(() => {
				const error = document.getElementById('site-error');
				return { checked: document.getElementById('site').getAttribute('aria-checked'), visible: error.checkVisibility(), text: error.textContent, tone: error.dataset.tone, role: error.getAttribute('role'), icon: getComputedStyle(error, '::before').maskImage !== 'none' };
			})()`);
			for (const scheme of ['light', 'dark'] as const) {
				await popup.colorScheme(scheme);
				await popup.screenshot(await fresh(`p5e-site-failed-${lang}-${scheme}`));
				expect((await popup.evaluate<Pair[]>(contrastProbe)).filter((pair) => pair.ratio < 4.5)).toEqual([]);
			}
			await popup.close();
			seen[lang] = { before, ...after };
		} finally {
			await h.close();
		}
	}
	console.log(JSON.stringify(seen));
	const shape = { before: 'true', checked: 'true', visible: true, tone: 'error', role: 'alert', icon: true };
	expect(seen.en).toEqual({ ...shape, text: 'tfold could not change this site. Try again.' });
	expect(seen.ko).toEqual({ ...shape, text: '이 사이트 설정을 바꾸지 못했어요. 다시 해 보세요.' });
});

test('lane 17: the tallest popup stays under the 600 px that Chrome allows and nothing spills out of its 320 px, on Linux and Mac labels and with the longest shortcuts', async ({ headless }) => {
	test.setTimeout(120_000);
	const seen: Record<string, Fit> = {};
	const longest = {
		fold: { code: 'ArrowDown', ctrl: true, alt: true, shift: true, meta: true },
		unfold: { code: 'ArrowUp', ctrl: true, alt: true, shift: true, meta: true },
	};
	const states = [
		{ name: 'pro trial ending, low', account: { kind: 'pro', trialEndsAt: inDays(1), remainingPercent: 8, resetsAt: inDays(20) } },
		{ name: 'pro, empty', account: { kind: 'pro', remainingPercent: 0, resetsAt: inDays(20) } },
		{ name: 'free, no key', account: { kind: 'free' } },
		{ name: 'signed out', account: { kind: 'signedOut' } },
	];
	for (const lang of ['en', 'ko'] as const) {
		const h = await launch({ headless, lang, account: null });
		try {
			await h.navigate(fixtures.wiki);
			await ready(h);
			const popup = await h.openPopup();
			await popup.evaluate(`document.getElementById('site-error').hidden = false`);
			for (const { name, account } of states) {
				for (const shortcuts of [undefined, longest]) {
					await worker(h).evaluate(
						async ({ account, shortcuts }) => {
							await chrome.storage.local.set({ account });
							if (shortcuts) await chrome.storage.local.set({ shortcuts });
							else await chrome.storage.local.remove('shortcuts');
						},
						{ account, shortcuts },
					);
					await popup.evaluate('new Promise((resolve) => setTimeout(resolve, 120))');
					seen[`${lang} ${name}${shortcuts ? ', longest shortcuts' : ''}`] = await popup.evaluate<Fit>(fitProbe);
					if (name.startsWith('pro trial')) await popup.screenshot(await fresh(`p5e-tallest-${lang}${shortcuts ? '-long' : ''}`));
				}
			}
			await popup.close();
		} finally {
			await h.close();
		}
		const mac = await launch({ headless, lang });
		try {
			await mac.context.addInitScript(`Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })`);
			await worker(mac).evaluate((account) => chrome.storage.local.set({ account }), states[0]?.account);
			const page = await mac.context.newPage();
			await page.setViewportSize({ width: 320, height: 600 });
			await page.goto(`chrome-extension://${mac.extensionId}/popup/popup.html`);
			await expect(page.locator('#scroll-keys')).toHaveText(lang === 'ko' ? 'Cmd+스크롤 ↓ ↑' : 'Cmd+scroll ↓ ↑');
			await expect(page.locator('#usage')).toBeVisible();
			seen[`${lang} Mac labels`] = await page.evaluate<Fit>(fitProbe);
			await page.screenshot({ path: await fresh(`p5e-popup-mac-${lang}`) });
			await page.close();
		} finally {
			await mac.close();
		}
	}
	console.log(JSON.stringify(seen, null, 1));
	for (const [where, fit] of Object.entries(seen)) {
		expect(fit.height, where).toBeLessThan(600);
		expect(fit.width, where).toBeLessThanOrEqual(320);
		expect(fit.spilled, where).toEqual([]);
	}
});
