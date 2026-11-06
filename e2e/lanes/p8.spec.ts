import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Route } from '@playwright/test';
import type { Account } from '../../src/account.ts';
import { localFold } from '../../src/fold/local.ts';
import { en, enStore } from '../../src/strings/en.ts';
import { ko, koStore } from '../../src/strings/ko.ts';
import { contrastProbe, type Pair } from '../contrast.ts';
import { editionDirs, fixtures, launch, foldAt, type Harness, type Popup } from '../harness.ts';
import { expect, test } from '../lane.ts';
import { openGatewayKeyReply } from '../provider-replies.ts';

const outDir = path.resolve(import.meta.dirname, '..', 'out', 'p8');
const openDist = process.env.TFOLD_OPEN_DIST ?? editionDirs.open;
const latchMs = 400;
const foldDown = 'Alt+Shift+ArrowDown';
const wikiParagraphs = '#mw-content-text section > p:not(.mw-empty-elt):not([data-tf-overlay], [data-tfold-overlay])';
const providerUrl = 'https://apis.opengateway.ai/v1/chat/completions';
const mockTakeaway = 'A mocked takeaway from the provider.';

const langs = ['en', 'ko'] as const;
const schemes = ['light', 'dark'] as const;
const tables = { en, ko };
const storeTables = { en: enStore, ko: koStore };
const storeOnlyElements = ['#signed-out', '#continue', '#try-first', '#usage', '#meter', '#trial-left', '.dev-link', '#sign-in', '#dev-account', '.google'];

const accountWording = /\bsign.?in\b|\bsigned.?(in|out)\b|\blog.?in\b|tfold\.xyz|\bpro\b|\btrial\b|\bplan\b|\busage\b|subscri|with google|로그인|로그아웃|체험|요금제|구독|사용량/i;
const bundleWording = /\bsign.?in\b|\bsigned.?(in|out)\b|\blog.?in\b|tfold\.xyz|\bpro\b|\btrial|with google|class="google"|google\.svg|로그인|로그아웃|체험|요금제|구독|사용량|tf-hud|dev-account|development build/gi;

const nth = (selector: string, index: number) => `${selector} >> nth=${index}`;
const worker = (h: Harness) => h.context.serviceWorkers().at(-1) ?? h.worker;
const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const ready = (page: Page) => expect.poll(() => page.evaluate(() => document.readyState)).toBe('complete');
const lowContrast = (pairs: Pair[]) => pairs.filter((pair) => pair.ratio < (pair.size >= 24 ? 3 : 4.5));
const launchOpen = (headless: boolean, lang: string = 'en', account: Account | null = null) => launch({ headless, lang, account }, openDist);

async function fresh(slug: string): Promise<string> {
	const file = path.join(outDir, `${slug}.png`);
	await mkdir(outDir, { recursive: true });
	await rm(file, { force: true });
	return file;
}

const storedAccount = (h: Harness) => worker(h).evaluate(() => chrome.storage.local.get('account'));
const toolbar = (h: Harness) =>
	worker(h).evaluate(async () => {
		const [tab] = await chrome.tabs.query({ active: true });
		if (tab?.id === undefined) return null;
		return { badge: await chrome.action.getBadgeText({ tabId: tab.id }), title: await chrome.action.getTitle({ tabId: tab.id }) };
	});

const overlay = (page: Page, index: number) =>
	page.evaluate(
		({ selector, index }) => {
			const shown = document.querySelectorAll(selector)[index]?.nextElementSibling;
			if (!shown?.matches('[data-tf-overlay], [data-tfold-overlay]')) return null;
			return {
				level: shown.getAttribute('data-tf-level'),
				fold: shown.getAttribute('data-tf-fold'),
				badge: shown.getAttribute('data-tf-badge'),
				text: (shown.textContent ?? '').replace(/\s+/g, ' ').trim(),
			};
		},
		{ selector: wikiParagraphs, index },
	);

const original = (page: Page, index: number) =>
	page.evaluate(({ selector, index }) => (document.querySelectorAll(selector)[index]?.textContent ?? '').replace(/\s+/g, ' ').trim(), { selector: wikiParagraphs, index });

type PopupView = { present: string[]; view: boolean; title: string | null; state: string | null; addKey: string | null; howToFirst: boolean; html: string };

const readPopup = (popup: Popup) =>
	popup.evaluate<PopupView>(`(() => {
		const visible = (selector) => document.querySelector(selector)?.checkVisibility() === true;
		const text = (selector) => (visible(selector) ? document.querySelector(selector).textContent.trim() : null);
		const howTo = document.getElementById('how-to').getBoundingClientRect();
		return {
			present: ${JSON.stringify(storeOnlyElements)}.filter((selector) => document.querySelector(selector) !== null),
			view: visible('#view'),
			title: text('#provider-title'),
			state: text('#provider-state'),
			addKey: text('#add-key'),
			howToFirst: howTo.bottom <= document.getElementById('provider-row').getBoundingClientRect().top,
			html: document.documentElement.outerHTML,
		};
	})()`);

async function openSettings(h: Harness, width = 860, height = 900): Promise<Page> {
	const settings = await h.context.newPage();
	await settings.setViewportSize({ width, height });
	await settings.goto(`chrome-extension://${h.extensionId}/options/options.html`);
	await expect(settings.locator('#route')).not.toBeEmpty();
	return settings;
}

const readSettings = (page: Page) =>
	page.evaluate((storeOnly) => {
		const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? null;
		return {
			present: storeOnly.filter((selector) => document.querySelector(selector) !== null),
			intro: text('#intro'),
			provider: document.getElementById('provider-section')?.checkVisibility() === true,
			sites: document.getElementById('sites-section')?.checkVisibility() === true,
			privacy: [...document.querySelectorAll('#privacy dt')].map((term) => [term.textContent, term.nextElementSibling?.textContent]),
			reason: document.getElementById('auto-translate-reason')?.checkVisibility() === true ? text('#auto-translate-reason-link') : null,
			html: document.documentElement.outerHTML,
		};
	}, storeOnlyElements);

function routeProvider(h: Harness) {
	const asked: ('key check' | 'fold')[] = [];
	const answer = async (route: Route) => {
		const sent = route.request().postData() ?? '{}';
		const body = JSON.parse(sent) as { messages?: { content: string }[] };
		if (!body.messages) {
			asked.push('key check');
			await route.fulfill({ status: 400, contentType: 'application/json', body: openGatewayKeyReply(sent) });
			return;
		}
		asked.push('fold');
		const units = [...(body.messages.at(-1)?.content ?? '').matchAll(/^\[U(\d+)\]/gm)].map(([, n]) => ({ id: `U${n}`, takeaway: mockTakeaway, reason: '', evidence: [0] }));
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ id: 'gen-mock', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ units }) } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }),
		});
	};
	return h.context.route(providerUrl, answer).then(() => asked);
}

test('lane 1: on a clean profile with no setup, a fold and the shortcut each fold at once to the quick summary, the badge asks for a key, and nothing is sent or written for an account', async ({ headless }) => {
	const h = await launchOpen(headless);
	try {
		await h.navigate(fixtures.wiki);
		await ready(h.page);
		expect(await storedAccount(h), 'a clean profile').toEqual({});

		const before = [await original(h.page, 1), await original(h.page, 3)];
		const point = await h.pointAt(nth(wikiParagraphs, 1));
		const foldStartedAt = Date.now();
		await h.foldAt(point.x, point.y, 1);
		await expect.poll(() => overlay(h.page, 1), { timeout: 2000 }).toMatchObject({ level: '1', fold: 'local' });
		const foldMs = Date.now() - foldStartedAt;
		await h.page.waitForTimeout(latchMs + 100);

		await h.pointAt(nth(wikiParagraphs, 3));
		await h.press(foldDown);
		await expect.poll(() => overlay(h.page, 3), { timeout: 2000 }).toMatchObject({ level: '1', fold: 'local' });

		await expect.poll(() => overlay(h.page, 1).then((shown) => shown?.badge)).toBe(en.badgeNoKey);
		const shown = [await overlay(h.page, 1), await overlay(h.page, 3)];
		console.log(`fold folded in ${foldMs} ms; worker: ${h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('fold ')).map((entry) => entry.text).join('; ')}`);
		expect(shown.map((fold) => fold?.text)).toEqual(before.map((text) => localFold(text).sentences[0]));
		expect(await toolbar(h)).toEqual({ badge: '', title: en.actionOn(new URL(h.baseURL).hostname) });
		expect(await storedAccount(h), 'nothing is written for an account').toEqual({});
		expect(h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('fold request'))).toEqual([]);
		expect(h.blockedRequests).toEqual([]);
		expect(errors(h)).toEqual([]);
	} finally {
		await h.close();
	}
});

test('lane 2: the first-run popup has no sign-in view and no usage row, leads with how to fold, says quick summaries work and offers a key, and that offer opens the key field', async ({ headless }) => {
	for (const lang of langs) {
		const h = await launchOpen(headless, lang);
		try {
			await h.navigate(fixtures.wiki);
			await ready(h.page);
			const popup = await h.openPopup();
			await popup.screenshot(await fresh(`p8-popup-first-run-${lang}`));
			const seen = await readPopup(popup);
			expect(seen, lang).toMatchObject({ present: [], view: true, title: tables[lang].popupNoKeyTitle, state: tables[lang].popupNoKeyBody('OpenGateway'), addKey: tables[lang].popupAddKey, howToFirst: true });
			const [settings] = await Promise.all([h.context.waitForEvent('page'), popup.click('#add-key')]);
			await settings.waitForLoadState('load');
			await expect(settings.locator('#key')).toBeFocused();
			expect(h.blockedRequests).toEqual([]);
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	}
});

test('lane 3: settings read for a reader with no account, with the key form and the site list, the quick-summary intro, the unlock link going to the key field, and a sample that folds and points at any article', async ({ headless }) => {
	for (const lang of langs) {
		const table = tables[lang];
		const h = await launchOpen(headless, lang);
		try {
			const settings = await openSettings(h);
			const seen = await readSettings(settings);
			expect(seen, lang).toMatchObject({ present: [], intro: table.settingsIntro, provider: true, sites: true, privacy: table.privacy, reason: table.autoTranslateNeedsKey });
			expect(seen.privacy[0]?.[1], `${lang} says a saved key comes first`).toMatch(lang === 'en' ? /^Only with a saved key/ : /^저장한 키로/);

			await settings.locator('#auto-translate-reason-link').click();
			await expect(settings.locator('#key')).toBeFocused();

			await settings.locator('#sample-stage').scrollIntoViewIfNeeded();
			const stage = await settings.locator('#sample-stage').boundingBox();
			if (!stage) throw new Error('the sample has no box');
			const x = stage.x + stage.width / 2;
			const y = stage.y + stage.height / 2;
			await settings.mouse.move(x, y);
			await foldAt(await h.context.newCDPSession(settings), x, y, 1);
			await expect(settings.locator('#sample-next')).toHaveText(table.sampleNext);
			await expect(settings.locator('#sample-level')).toContainText(table.sampleQuickLevels[1].name);
			expect(h.blockedRequests).toEqual([]);
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	}
});

test('lane 4: no surface shows sign-in, Pro or trial wording and nothing reaches the website, in both languages and both themes', async ({ headless }) => {
	test.setTimeout(240_000);
	const surfaces: [string, string][] = [];
	for (const lang of langs) {
		const table = tables[lang];
		const h = await launchOpen(headless, lang);
		const host = new URL(h.baseURL).hostname;
		try {
			await h.navigate(fixtures.wiki);
			await ready(h.page);
			await h.pointAt(nth(wikiParagraphs, 1));
			await expect(h.page.locator('tf-hint')).toHaveCount(1, { timeout: 4000 });
			surfaces.push([`${lang} hint`, await h.page.evaluate(() => document.querySelector('tf-hint')?.shadowRoot?.textContent ?? '')]);
			await h.press(foldDown);
			await expect.poll(() => overlay(h.page, 1).then((shown) => shown?.badge)).toBe(table.badgeNoKey);
			surfaces.push([`${lang} badge`, table.badgeNoKey]);
			const on = await toolbar(h);
			expect(on?.title, lang).toBe(table.actionOn(host));
			surfaces.push([`${lang} toolbar`, JSON.stringify(on)]);

			for (const scheme of schemes) {
				const popup = await h.openPopup();
				await popup.colorScheme(scheme);
				const seen = await readPopup(popup);
				expect(seen.present, `${lang} ${scheme} popup`).toEqual([]);
				surfaces.push([`${lang} ${scheme} popup`, seen.html]);
				await popup.screenshot(await fresh(`p8-popup-${lang}-${scheme}`));
				expect(lowContrast(await popup.evaluate<Pair[]>(contrastProbe)), `${lang} ${scheme} popup`).toEqual([]);
				await popup.close();
				await h.page.bringToFront();
			}

			const switching = await h.openPopup();
			await switching.click('#site');
			await expect.poll(() => switching.evaluate<string>(`document.getElementById('provider-title').textContent`)).toBe(table.popupSiteOff);
			surfaces.push([`${lang} popup, site off`, (await readPopup(switching)).html]);
			await switching.click('#site');
			await expect.poll(() => toolbar(h).then((state) => state?.title)).toBe(table.actionOn(host));
			await switching.close();
			await h.page.bringToFront();

			const settings = await openSettings(h);
			for (const scheme of schemes) {
				await settings.emulateMedia({ colorScheme: scheme });
				const seen = await readSettings(settings);
				expect(seen.present, `${lang} ${scheme} settings`).toEqual([]);
				surfaces.push([`${lang} ${scheme} settings`, seen.html]);
				await settings.screenshot({ path: await fresh(`p8-settings-${lang}-${scheme}`), fullPage: true, animations: 'disabled' });
				expect(lowContrast(await settings.evaluate<Pair[]>(contrastProbe)), `${lang} ${scheme} settings`).toEqual([]);
			}
			const onSettings = await h.openPopup(settings);
			surfaces.push([`${lang} popup, not a web page`, (await readPopup(onSettings)).html]);
			await onSettings.close();

			expect((await h.tabUrls()).filter((url) => url.includes('tfold.xyz')), lang).toEqual([]);
			expect(h.blockedRequests, lang).toEqual([]);
			expect(errors(h), lang).toEqual([]);
		} finally {
			await h.close();
		}
	}
	for (const [name, text] of surfaces) {
		expect(text.trim(), `${name} has text to read`).not.toBe('');
		expect(text.match(accountWording), name).toBeNull();
	}
	expect(surfaces, 'every surface in each language and theme').toHaveLength(2 * (3 + 2 + 1 + 2 + 1));
});

test('lane 5: with a mocked key saved in settings, the provider writes the AI summary and the popup names it, and nothing else is asked', async ({ headless }) => {
	const h = await launchOpen(headless);
	try {
		const asked = await routeProvider(h);
		const settings = await openSettings(h);
		await settings.locator('#key').fill('sk-test-open');
		await settings.locator('#save').click();
		await expect(settings.locator('#status')).toHaveAttribute('data-tone', 'success', { timeout: 12_000 });
		await expect(settings.locator('#route')).toHaveText(en.routeOne('OpenGateway'));
		await settings.close();
		await h.page.bringToFront();

		await h.navigate(fixtures.wiki);
		await ready(h.page);
		await h.pointAt(nth(wikiParagraphs, 1));
		await h.press(foldDown);
		await expect.poll(() => overlay(h.page, 1).then((shown) => shown?.fold), { timeout: 8000 }).toBe('model');
		await h.press(foldDown);
		await h.press(foldDown);
		await expect.poll(() => overlay(h.page, 1).then((shown) => shown?.text)).toBe(mockTakeaway);

		const popup = await h.openPopup();
		expect(await readPopup(popup)).toMatchObject({ present: [], title: en.popupProvider('OpenGateway'), state: en.popupKeySaved, addKey: null });
		expect(asked[0]).toBe('key check');
		expect(asked).toContain('fold');
		expect(await storedAccount(h)).toEqual({});
		expect(h.blockedRequests).toEqual([]);
		expect(errors(h)).toEqual([]);
	} finally {
		await h.close();
	}
});

test('lane 6: a stored signed-out or Pro account from an earlier development build is ignored and left alone, and the worker refuses to set one', async ({ headless }) => {
	test.setTimeout(180_000);
	const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
	const leftovers: Record<string, Account> = {
		'signed out': { kind: 'signedOut' },
		'pro trial': { kind: 'pro', trialEndsAt: inDays(4), remainingPercent: 72, resetsAt: inDays(20) },
		'pro at 0%': { kind: 'pro', remainingPercent: 0, resetsAt: inDays(12) },
	};
	for (const [name, account] of Object.entries(leftovers)) {
		const h = await launchOpen(headless, 'en', account);
		try {
			await worker(h).evaluate(() => chrome.storage.local.set({ providers: { chosen: 'opengateway', opengateway: { apiKey: 'test-key' } } }));
			const asked = await routeProvider(h);
			await h.navigate(fixtures.wiki);
			await ready(h.page);
			await h.pointAt(nth(wikiParagraphs, 1));
			await h.press(foldDown);
			await expect.poll(() => overlay(h.page, 1).then((shown) => shown?.fold), { message: `${name} folds with the key`, timeout: 8000 }).toBe('model');
			expect(asked, name).toContain('fold');

			const popup = await h.openPopup();
			expect(await readPopup(popup), name).toMatchObject({ present: [], view: true, title: en.popupProvider('OpenGateway') });
			await popup.close();
			await h.page.bringToFront();

			const settings = await openSettings(h);
			expect(await readSettings(settings), name).toMatchObject({ present: [], intro: en.settingsIntro, provider: true, sites: true, privacy: en.privacy, reason: null });
			const refused = await settings.evaluate(() => chrome.runtime.sendMessage<unknown, boolean>({ type: 'set-account', account: { kind: 'signedOut' } }));
			expect(refused, name).toBe(false);
			expect(await storedAccount(h), `${name} stays as it was`).toEqual({ account });

			await worker(h).evaluate(() => chrome.storage.local.set({ account: { kind: 'signedOut' } }));
			await settings.close();
			await h.page.bringToFront();
			await h.page.waitForTimeout(500);
			expect(await overlay(h.page, 1), `${name} a change in storage keeps the fold`).toMatchObject({ level: '1', fold: 'model' });
			expect(await toolbar(h).then((state) => state?.title), name).toBe(en.actionOn(new URL(h.baseURL).hostname));
			expect(h.blockedRequests, name).toEqual([]);
			expect(errors(h), name).toEqual([]);
		} finally {
			await h.close();
		}
	}
});

type BuiltFile = { file: string; text: string };

async function builtFiles(dir: string): Promise<BuiltFile[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	const files = entries.filter((entry) => entry.isFile()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
	return Promise.all(files.sort().map(async (file) => ({ file, text: file.endsWith('.png') ? '' : await readFile(path.join(dir, file), 'utf8') })));
}

const hits = (files: BuiltFile[], pattern: RegExp) => files.flatMap(({ file, text }) => [...text.matchAll(pattern)].map(([word]) => `${file}: ${word}`));
const wordsOf = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(wordsOf) : []);
const storeOnlyWords = (lang: 'en' | 'ko') => {
	const shared = Object.values(tables[lang]).flatMap(wordsOf);
	return Object.values(storeTables[lang])
		.flatMap(wordsOf)
		.filter((word) => word.includes(' ') && !shared.some((each) => each.includes(word)));
};

test('lane 7: the open bundle, its pages and _locales hold no sign-in, Pro or trial string and no store string or key, while the store build holds them, and both carry the same manifest and locales', async () => {
	const open = await builtFiles(openDist);
	const store = await builtFiles(editionDirs.store);
	const fileOf = (files: BuiltFile[], file: string) => files.find((each) => each.file === file)?.text;

	console.log(`open edition, ${open.length} files; store edition, ${store.length} files, with ${hits(store, bundleWording).length} matches of the same search`);
	expect(hits(open, bundleWording)).toEqual([]);
	expect(hits(open, /<!-- \/?store -->|\/\* \/?store \*\//g), 'no marker reaches a page').toEqual([]);
	expect(hits(store, /<!-- \/?store -->|\/\* \/?store \*\//g), 'no marker reaches a page').toEqual([]);
	expect(open.map(({ file }) => file)).not.toContain(path.join('ui', 'google.svg'));
	expect(store.map(({ file }) => file)).toContain(path.join('ui', 'google.svg'));

	for (const lang of langs) {
		const storeKeys = new RegExp(`\\b(?:${Object.keys(storeTables[lang]).join('|')})\\b`, 'g');
		expect(hits(open, storeKeys), `${lang} store keys`).toEqual([]);
		expect(hits(store, storeKeys).length, `${lang} store keys, the same search on the store build`).toBeGreaterThan(0);
		for (const word of storeOnlyWords(lang)) {
			expect(open.filter(({ text }) => text.includes(word)).map(({ file }) => file), word).toEqual([]);
			expect(store.filter(({ text }) => text.includes(word)).length, `${word} in the store build`).toBeGreaterThan(0);
		}
	}
	for (const word of ['https://tfold.xyz/signin', 'Continue with Google', 'Google로 계속하기', 'Pro 요금제', 'Trial ends today', 'id="signed-out"', 'id="usage"', 'id="sign-in"']) {
		expect(store.filter(({ text }) => text.includes(word)).length, `${word} in the store build`).toBeGreaterThan(0);
	}
	for (const file of ['manifest.json', path.join('_locales', 'en', 'messages.json'), path.join('_locales', 'ko', 'messages.json')]) {
		expect(fileOf(open, file), file).toBe(fileOf(store, file));
	}
});
