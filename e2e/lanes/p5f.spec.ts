import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { signInUrl, type Account } from '../../src/account.ts';
import { en } from '../../src/strings/en.ts';
import { ko } from '../../src/strings/ko.ts';
import { contrastProbe, pairsOf, type Pair } from '../contrast.ts';
import { extensionDir, fixtures, launch, type Harness, type Popup } from '../harness.ts';
import { expect, inKorean, test } from '../lane.ts';
import { openGatewayKeyReply, openRouterKeyReply } from '../provider-replies.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p5f');
const wikiParagraphs = '#mw-content-text section > p:not(.mw-empty-elt):not([data-tfold-overlay])';
const nth = (selector: string, index: number) => `${selector} >> nth=${index}`;
const worker = (h: Harness) => h.context.serviceWorkers().at(-1) ?? h.worker;
const optionsUrl = (h: Harness) => `chrome-extension://${h.extensionId}/options/options.html`;
const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const ready = (page: Page) => expect.poll(() => page.evaluate(() => document.readyState)).toBe('complete');

type Lang = 'en' | 'ko';
type State = 'signedout' | 'free' | 'pro';
type Scheme = 'light' | 'dark';

const langs: Lang[] = ['en', 'ko'];
const schemes: Scheme[] = ['light', 'dark'];
const accounts: Record<State, Account> = {
	signedout: { kind: 'signedOut' },
	free: { kind: 'free' },
	pro: { kind: 'pro', trialEndsAt: inDays(4), remainingPercent: 72, resetsAt: inDays(20) },
};

async function fresh(slug: string): Promise<string> {
	const file = path.join(outDir, `${slug}.png`);
	await mkdir(outDir, { recursive: true });
	await rm(file, { force: true });
	return file;
}

const setAccount = (h: Harness, account: Account) => worker(h).evaluate((account) => chrome.storage.local.set({ account }), account);
const setLanguage = (h: Harness, readerLanguage: string) => worker(h).evaluate((readerLanguage) => chrome.storage.sync.set({ readerLanguage }), readerLanguage);
const storedLanguage = (h: Harness) => worker(h).evaluate(() => chrome.storage.sync.get('readerLanguage'));
const saveKey = (h: Harness) => worker(h).evaluate(() => chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter: { apiKey: 'test-key' } } }));
const storedProviders = (h: Harness) => worker(h).evaluate(() => chrome.storage.local.get('providers'));

type PopupView = { lang: string; shown: string[]; keyWords: string[]; texts: Record<string, string | null>; marker: number | null };

const readPopup = (popup: Popup) =>
	popup.evaluate<PopupView>(`(() => {
		const parts = ['#signed-out', '#continue', '#usage', '#site', '#provider-title', '#add-key', '#fold-keys', '#settings', '.dev-link'];
		const visible = (selector) => document.querySelector(selector)?.checkVisibility() === true;
		const text = (selector) => (visible(selector) ? document.querySelector(selector).textContent.trim() : null);
		return {
			lang: document.documentElement.lang,
			shown: parts.filter(visible),
			keyWords: document.body.innerText.match(/API|OpenRouter|OpenGateway|\\bkeys?\\b|(?<!단축)키/g) ?? [],
			texts: {
				signedOut: text('#signed-out p'),
				continue: text('#continue'),
				usage: text('#usage-left'),
				site: text('#site-title'),
				provider: text('#provider-title'),
				how: text('#how-title'),
				settings: text('#settings'),
			},
			marker: window.p5fMarker ?? null,
		};
	})()`);

const popupShape = `(() => {
	const style = (selector) => getComputedStyle(document.querySelector(selector));
	return {
		card: style('.group').borderTopLeftRadius,
		meter: [style('.meter').height, style('.meter').borderTopLeftRadius],
		key: style('kbd').borderTopLeftRadius,
		switch: style('#site').borderTopLeftRadius,
		gutter: style('main').paddingLeft,
		row: [style('.row').paddingTop, style('.row').paddingLeft],
	};
})()`;

const readOptions = (page: Page) =>
	page.evaluate(() => {
		const text = (selector: string) => document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
		return {
			lang: document.documentElement.lang,
			title: document.title,
			heading: text('h1'),
			provider: document.getElementById('provider-section')?.checkVisibility() === true,
			sections: [...document.querySelectorAll('h2')].filter((h2) => h2.checkVisibility()).map((h2) => h2.textContent),
			intro: text('#intro'),
			privacy: text('#privacy'),
			language: document.querySelector<HTMLInputElement>('input[name="language"]:checked')?.value ?? null,
			providerWords: document.body.innerText.match(/API|OpenRouter|OpenGateway/g) ?? [],
			keyState: document.getElementById('key-state')?.checkVisibility() ? text('#key-state') : null,
			marker: (window as { p5fMarker?: number }).p5fMarker ?? null,
		};
	});

const popupParts: Record<State, string[]> = {
	signedout: ['#signed-out', '#continue'],
	free: ['#site', '#provider-title', '#add-key', '#fold-keys', '#settings'],
	pro: ['#usage', '#site', '#provider-title', '#fold-keys', '#settings'],
};

test('lane 1: the popup shows each account state in the reader language, Pro shows no key or provider, and a language change repaints the open popup', async ({
	h,
}) => {
	const seen: Record<string, PopupView> = {};
	const contrast: { where: string; pairs: Pair[] }[] = [];
	await h.navigate(fixtures.wiki);
	await ready(h.page);
	const popup = await h.openPopup();
	await popup.evaluate('window.p5fMarker = 1');
	const shape = await popup.evaluate<Record<string, unknown>>(popupShape);
	for (const lang of langs) {
		await setLanguage(h, lang);
		for (const state of ['signedout', 'free', 'pro'] as const) {
			await setAccount(h, accounts[state]);
			await expect.poll(async () => (await readPopup(popup)).shown).toEqual(popupParts[state]);
			await expect.poll(async () => (await readPopup(popup)).lang).toBe(lang);
			seen[`${lang} ${state}`] = await readPopup(popup);
			for (const scheme of schemes) {
				await popup.colorScheme(scheme);
				await popup.screenshot(await fresh(`p5f-popup-${lang}-${state}-${scheme}`));
				contrast.push({ where: `popup ${lang} ${state} ${scheme}`, pairs: await popup.evaluate<Pair[]>(contrastProbe) });
			}
		}
	}
	await popup.close();

	console.log(JSON.stringify({ shape, seen }, null, 1));
	for (const { where, pairs } of contrast) console.log(`${where}: ${pairsOf(pairs).map((pair) => `${pair.fg} on ${pair.bg} ${pair.ratio}:1`).join('; ')}`);
	expect(shape).toEqual({ card: '20px', meter: ['8px', '999px'], key: '8px', switch: '999px', gutter: '20px', row: ['14px', '18px'] });
	expect(seen['en signedout']?.texts).toMatchObject({ signedOut: 'tfold shortens the paragraph you are reading, right where it is.', continue: 'Continue with Google' });
	expect(seen['ko signedout']?.texts).toMatchObject({ signedOut: '읽던 문단을 그 자리에서 짧게 접어 줘요.', continue: 'Google로 계속하기' });
	expect(seen['en free']?.texts).toMatchObject({ site: 'Use on this site', provider: 'Folding with quick summaries', settings: 'Open settings' });
	expect(seen['ko free']?.texts).toMatchObject({ site: '이 사이트에서 사용', provider: '빠른 요약으로 접고 있어요', settings: '설정 열기' });
	expect(seen['en pro']?.texts).toMatchObject({ usage: '72% left this month', site: 'Use on this site', provider: 'AI summaries with your Pro plan', how: 'Hold Ctrl and a green line marks the paragraph, then scroll. Or use the shortcut.' });
	expect(seen['ko pro']?.texts).toMatchObject({ usage: '이번 달 남은 사용량 72%', site: '이 사이트에서 사용', provider: 'Pro 요금제로 AI 요약을 받아요', how: 'Ctrl 누르고 있으면 문단 옆에 초록 선이 나와요. 그대로 스크롤하면 접혀요. 아래 단축키로도 접을 수 있어요.' });
	for (const lang of langs) {
		expect(seen[`${lang} free`]?.keyWords.length, `${lang} free names the key`).toBeGreaterThan(0);
		expect(seen[`${lang} pro`]?.keyWords, `${lang} pro`).toEqual([]);
		expect(seen[`${lang} signedout`]?.keyWords, `${lang} signed out`).toEqual([]);
	}
	expect(Object.values(seen).map(({ marker }) => marker)).toEqual(Object.values(seen).map(() => 1));
	expect(contrast.flatMap(({ where, pairs }) => pairs.filter((pair) => pair.ratio < (pair.size >= 24 ? 3 : 4.5)).map((pair) => ({ where, ...pair })))).toEqual([]);
	expect(errors(h)).toEqual([]);
});

test('lane 2: settings hide the provider and its keys from Pro and signed-out readers in both languages and schemes, keep the stored keys, and show them again on Free', async ({ h }) => {
	const seen: Record<string, Awaited<ReturnType<typeof readOptions>>> = {};
	const contrast: { where: string; pairs: Pair[] }[] = [];
	await saveKey(h);
	const keysBefore = await storedProviders(h);
	const settings = await h.context.newPage();
	await settings.setViewportSize({ width: 860, height: 900 });
	await settings.goto(optionsUrl(h));
	await expect(settings.locator('#route')).not.toBeEmpty();
	for (const lang of langs) {
		await setLanguage(h, lang);
		for (const state of ['pro', 'signedout', 'free'] as const) {
			await setAccount(h, accounts[state]);
			await expect.poll(async () => [(await readOptions(settings)).lang, (await readOptions(settings)).provider]).toEqual([lang, state === 'free']);
			seen[`${lang} ${state}`] = await readOptions(settings);
			for (const scheme of schemes) {
				await settings.emulateMedia({ colorScheme: scheme });
				if (state !== 'signedout') await settings.screenshot({ path: await fresh(`p5f-settings-${lang}-${state}-${scheme}`), fullPage: true, animations: 'disabled' });
				contrast.push({ where: `settings ${lang} ${state} ${scheme}`, pairs: await settings.evaluate<Pair[]>(contrastProbe) });
			}
		}
	}
	const keysWhilePro = await storedProviders(h);
	await setAccount(h, accounts.free);
	await expect.poll(async () => (await readOptions(settings)).provider).toBe(true);
	const backOnFree = await readOptions(settings);
	await settings.close();

	console.log(JSON.stringify(seen, null, 1));
	expect(seen['en free']).toMatchObject({
		title: 'tfold settings',
		sections: ['Try it here', 'AI summaries', 'Ways to fold', '언어 / Language', 'Sites where tfold is off', 'What tfold sends'],
		language: 'en',
		keyState: 'A key is saved. Type a new one to replace it.',
	});
	expect(seen['en pro']).toMatchObject({ provider: false, sections: ['Try it here', 'Ways to fold', '언어 / Language', 'Sites where tfold is off', 'What tfold sends'], providerWords: [], keyState: null });
	expect(seen['en pro']?.intro).toContain('while your Pro plan has usage left this month.');
	expect(seen['en pro']?.privacy).toContain('The tfold server, which makes the AI summary.');
	expect(seen['ko pro']).toMatchObject({ provider: false, title: 'tfold 설정', sections: ['여기서 접어 보기', '접는 방법', '언어 / Language', 'tfold를 끈 사이트', 'tfold가 보내는 것'], providerWords: [], language: 'ko' });
	expect(seen['ko pro']?.intro).toContain('이번 달 Pro 사용량이 남아 있는 동안');
	expect(seen['ko free']).toMatchObject({ provider: true, sections: ['여기서 접어 보기', 'AI 요약', '접는 방법', '언어 / Language', 'tfold를 끈 사이트', 'tfold가 보내는 것'] });
	expect(seen['en signedout']).toMatchObject({ provider: false, sections: ['Try it here', 'Ways to fold', '언어 / Language', 'What tfold sends'], providerWords: [] });
	expect(seen['ko signedout']).toMatchObject({ provider: false, sections: ['여기서 접어 보기', '접는 방법', '언어 / Language', 'tfold가 보내는 것'], providerWords: [] });
	expect(keysWhilePro).toEqual(keysBefore);
	expect(backOnFree).toMatchObject({ provider: true, keyState: '키가 저장돼 있어요. 바꾸려면 새 키를 넣으세요.' });
	expect(contrast.flatMap(({ where, pairs }) => pairs.filter((pair) => pair.ratio < (pair.size >= 24 ? 3 : 4.5)).map((pair) => ({ where, ...pair })))).toEqual([]);
	expect(errors(h)).toEqual([]);
});

test('lane 3: picking a language in settings repaints the settings page without a reload, and an open article page hints in it and relabels a badge it already shows', async ({ h }) => {
	const settings = await h.context.newPage();
	await settings.setViewportSize({ width: 860, height: 900 });
	await settings.goto(optionsUrl(h));
	await expect(settings.locator('#route')).not.toBeEmpty();
	await settings.evaluate(() => Object.assign(window, { p5fMarker: 1 }));
	const before = { page: await readOptions(settings), stored: await storedLanguage(h) };
	await settings.locator('input[name="language"][value="ko"]').check();
	await expect.poll(async () => (await readOptions(settings)).lang).toBe('ko');
	const korean = { page: await readOptions(settings), stored: await storedLanguage(h) };
	await settings.screenshot({ path: await fresh('p5f-settings-language-ko'), fullPage: true, animations: 'disabled' });

	await worker(h).evaluate(() => chrome.storage.local.set({ hintSeen: false }));
	await h.page.bringToFront();
	await h.navigate(fixtures.wiki);
	await ready(h.page);
	await h.page.evaluate(() => Object.assign(window, { p5fMarker: 1 }));
	await h.pointAt(nth(wikiParagraphs, 1));
	await expect(h.page.locator('tf-hint')).toHaveCount(1, { timeout: 4000 });
	const hint = await h.page.evaluate(() => document.querySelector('tf-hint')?.shadowRoot?.querySelector('div')?.textContent);
	const { x, y } = await h.pointAt(nth(wikiParagraphs, 1));
	await h.foldAt(x, y, 1);
	await expect.poll(() => h.page.locator('[data-tf-badge]').count()).toBe(1);
	const koreanBadge = await h.page.locator('[data-tf-badge]').getAttribute('data-tf-badge');

	await settings.bringToFront();
	await settings.locator('input[name="language"][value="auto"]').check();
	await expect.poll(async () => (await readOptions(settings)).lang).toBe('en');
	const auto = { page: await readOptions(settings), stored: await storedLanguage(h) };
	await expect.poll(() => h.page.locator('[data-tf-badge]').getAttribute('data-tf-badge')).toBe('Add a key in tfold settings to get AI summaries');
	const englishBadge = { text: await h.page.locator('[data-tf-badge]').getAttribute('data-tf-badge'), level: await h.page.locator('[data-tfold-overlay]').getAttribute('data-tf-level') };
	const pageMarker = await h.page.evaluate(() => (window as { p5fMarker?: number }).p5fMarker ?? null);
	await settings.close();

	console.log(JSON.stringify({ before, korean, auto, hint, koreanBadge, englishBadge, pageMarker }, null, 1));
	expect(before).toMatchObject({ page: { lang: 'en', heading: 'Settings', language: 'auto' }, stored: {} });
	expect(korean).toMatchObject({
		page: { lang: 'ko', title: 'tfold 설정', heading: '설정', language: 'ko', marker: 1 },
		stored: { readerLanguage: 'ko' },
	});
	expect(korean.page.sections).toEqual(['여기서 접어 보기', 'AI 요약', '접는 방법', '언어 / Language', 'tfold를 끈 사이트', 'tfold가 보내는 것']);
	expect(auto).toMatchObject({ page: { lang: 'en', title: 'tfold settings', language: 'auto', marker: 1 }, stored: { readerLanguage: 'auto' } });
	expect(hint).toBe('Ctrl 키를 누른 채 문단 위에서 아래로 스크롤하면 접히고, 위로 스크롤하면 펼쳐져요. 단축키는 Alt+Shift+↓, Alt+Shift+↑');
	expect(koreanBadge).toBe('AI 요약을 받으려면 tfold 설정에서 키를 넣어 주세요');
	expect(englishBadge).toEqual({ text: 'Add a key in tfold settings to get AI summaries', level: '1' });
	expect(pageMarker).toBe(1);
	expect(errors(h)).toEqual([]);
});

test('lane 4: the signed-out sign-in button opens the sign-in page on the website, and only a development build adds a link to the account switch', async ({ h, headless }) => {
	const opened: Record<string, string[]> = {};
	for (const [build, dir] of [
		['store', extensionDir],
		['dev', path.join(outDir, 'dist-dev')],
	] as const) {
		if (build === 'dev') {
			const built = spawnSync('node', ['scripts/build.ts', '--dev', '--outdir', dir], { cwd: repoRoot, encoding: 'utf8' });
			expect(built.status, built.stderr).toBe(0);
		}
		const run = build === 'store' ? h : await launch({ headless, account: null }, dir);
		try {
			await run.context.route(signInUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<title>tfold sign-in</title>' }));
			await setAccount(run, accounts.signedout);
			await run.navigate(fixtures.wiki);
			await ready(run.page);
			const popup = await run.openPopup();
			await expect.poll(async () => (await readPopup(popup)).shown).toEqual(build === 'store' ? popupParts.signedout : [...popupParts.signedout, '.dev-link']);
			if (build === 'dev') await popup.screenshot(await fresh('p5f-popup-dev-signedout'));
			const target = build === 'store' ? signInUrl : optionsUrl(run);
			await popup.click(build === 'store' ? '#continue' : '.dev-link');
			await expect.poll(() => run.tabUrls()).toContain(target);
			opened[build] = (await run.tabUrls()).map((url) => url.replace(run.extensionId, '<id>'));
			expect(errors(run)).toEqual([]);
		} finally {
			if (run !== h) await run.close();
		}
	}
	const bundled = await Promise.all(['popup/popup.js', 'options/options.js'].map(async (file) => (await readFile(path.join(extensionDir, file), 'utf8')).includes('Development build')));

	console.log(JSON.stringify({ opened, bundled }));
	expect(opened.store).toContain(signInUrl);
	expect(opened.store).not.toContain('chrome-extension://<id>/options/options.html');
	expect(opened.dev).toContain('chrome-extension://<id>/options/options.html');
	expect(opened.dev).not.toContain(signInUrl);
	expect(bundled).toEqual([false, false]);
});

type Toolbar = { badge: string; title: string };
type ToolbarState = 'signedout' | 'on' | 'off';

const toolbarText = (host: string): Record<Lang, Record<ToolbarState, Toolbar>> => ({
	en: {
		signedout: { badge: '', title: 'Sign in to start using tfold' },
		on: { badge: '', title: `tfold is on for ${host}` },
		off: { badge: 'off', title: `tfold is off for ${host}` },
	},
	ko: {
		signedout: { badge: '', title: '로그인하면 tfold를 쓸 수 있어요' },
		on: { badge: '', title: `${host}에서 tfold가 켜져 있어요` },
		off: { badge: '꺼짐', title: `${host}에서 tfold가 꺼져 있어요` },
	},
});

const toolbars = (h: Harness) =>
	worker(h).evaluate(async () => {
		const tabs = (await chrome.tabs.query({})).sort((a, b) => a.index - b.index);
		return Promise.all(
			tabs.map(async ({ id: tabId }) => ({ badge: await chrome.action.getBadgeText({ tabId }), title: await chrome.action.getTitle({ tabId }) })),
		);
	});

async function toolbarFollowsReaderLanguage(h: Harness, browser: Lang): Promise<void> {
	const picked: Lang = browser === 'en' ? 'ko' : 'en';
	const text = toolbarText(new URL(h.baseURL).hostname);
	const both = (lang: Lang, state: ToolbarState) => [text[lang][state], text[lang][state]];
	const seen: Record<string, Toolbar[]> = {};
	const reach = async (name: string, expected: Toolbar[]) => {
		await expect.poll(() => toolbars(h), name).toEqual(expected);
		seen[name] = await toolbars(h);
	};
	await setLanguage(h, picked);
	await setAccount(h, accounts.signedout);
	await h.navigate(fixtures.wiki);
	await ready(h.page);
	const other = await h.context.newPage();
	await other.goto(new URL(fixtures.arxiv, h.baseURL).href, { waitUntil: 'load' });
	await ready(other);
	for (const page of [h.page, other]) await page.evaluate(() => Object.assign(window, { p5fMarker: 1 }));

	await reach(`signed out, ${picked} picked`, both(picked, 'signedout'));
	await setAccount(h, accounts.free);
	await reach(`on, ${picked} picked`, both(picked, 'on'));
	await h.page.bringToFront();
	const popup = await h.openPopup();
	await popup.click('#site');
	await reach(`off, ${picked} picked`, both(picked, 'off'));
	await popup.close();
	await setLanguage(h, browser);
	await reach(`off, ${browser} picked`, both(browser, 'off'));
	await setLanguage(h, picked);
	await reach(`off, ${picked} picked again`, both(picked, 'off'));
	await setLanguage(h, 'auto');
	await reach('off, auto', both(browser, 'off'));
	await setAccount(h, accounts.signedout);
	await reach('signed out, auto', both(browser, 'signedout'));
	const markers = await Promise.all([h.page, other].map((page) => page.evaluate(() => (window as { p5fMarker?: number }).p5fMarker ?? null)));
	await other.close();

	console.log(JSON.stringify({ browser, seen, markers }, null, 1));
	expect(markers).toEqual([1, 1]);
	expect(errors(h)).toEqual([]);
}

test('lane 5: in an English browser with 한국어 picked, the toolbar title and badge of every open tab speak Korean when signed out, on and off, and a language change repaints them without a reload', ({ h }) =>
	toolbarFollowsReaderLanguage(h, 'en'));

inKorean('lane 6: in a Korean browser with English picked, the toolbar title and badge of every open tab speak English when signed out, on and off, and a language change repaints them without a reload', ({ h }) =>
	toolbarFollowsReaderLanguage(h, 'ko'));

type ProviderId = 'openrouter' | 'opengateway';
type Answer = number | 'abort' | 'hang';

const keyCheckUrls = {
	openrouter: 'https://openrouter.ai/api/v1/key',
	opengateway: 'https://apis.opengateway.ai/v1/chat/completions',
} as const;

const keyCheckBody = (status: number, sent: string | null) => (status === 200 ? openRouterKeyReply : status === 400 ? openGatewayKeyReply(sent) : '{}');

async function stubKeyChecks(h: Harness) {
	const seen: { url: string; method: string; authorization: string | null; body: string | null }[] = [];
	const answer: { now: Answer } = { now: 200 };
	for (const url of Object.values(keyCheckUrls)) {
		await h.context.route(url, async (route) => {
			const request = route.request();
			seen.push({ url: request.url(), method: request.method(), authorization: await request.headerValue('authorization'), body: request.postData() });
			if (answer.now === 'hang') return;
			await (answer.now === 'abort' ? route.abort('connectionfailed') : route.fulfill({ status: answer.now, contentType: 'application/json', body: keyCheckBody(answer.now, request.postData()) }));
		});
	}
	return { seen, answer };
}

const seedProviders = (h: Harness, providers: object | undefined) =>
	worker(h).evaluate((providers) => (providers ? chrome.storage.local.set({ providers }) : chrome.storage.local.remove('providers')), providers);

const storedKey = async (h: Harness, id: ProviderId) => ((await storedProviders(h)).providers as Record<ProviderId, { apiKey?: string } | undefined> | undefined)?.[id]?.apiKey ?? '';

async function openSettings(h: Harness, width = 860, height = 900): Promise<Page> {
	const settings = await h.context.newPage();
	await settings.setViewportSize({ width, height });
	await settings.goto(optionsUrl(h));
	await expect(settings.locator('#route')).not.toBeEmpty();
	return settings;
}

const saveTone = (settings: Page, tone: string) => expect(settings.locator('#status')).toHaveAttribute('data-tone', tone, { timeout: 12_000 });

const verdicts: { name: string; answer: (id: ProviderId) => Answer; tone: string; saved: boolean; text: Record<Lang, (name: string) => string> }[] = [
	{
		name: 'works',
		answer: (id) => (id === 'openrouter' ? 200 : 400),
		tone: 'success',
		saved: true,
		text: { en: (name) => `The ${name} key works and is saved.`, ko: (name) => `${name} 키가 잘 작동해요. 저장했어요.` },
	},
	{
		name: 'refused',
		answer: () => 401,
		tone: 'error',
		saved: false,
		text: {
			en: (name) => `${name} refused this key, so tfold did not save it. Copy the whole key from ${name} and paste it again.`,
			ko: (name) => `${name}가 이 키를 거절해서 저장하지 않았어요. ${name}에서 키 전체를 다시 복사해 넣어 보세요.`,
		},
	},
	...(
		[
			['outage', 503],
			['offline', 'abort'],
		] as const
	).map(([name, answer]) => ({
		name,
		answer: () => answer,
		tone: 'caution',
		saved: true,
		text: {
			en: (name: string) => `tfold could not check the ${name} key right now, but it is saved. If AI summaries don't appear, paste the key again later.`,
			ko: (name: string) => `지금은 ${name} 키를 확인하지 못했지만 저장해 뒀어요. AI 요약이 안 나오면 나중에 키를 다시 넣어 보세요.`,
		},
	})),
];

const providerNames: Record<ProviderId, string> = { openrouter: 'OpenRouter', opengateway: 'OpenGateway' };

test('lane 7: on save, the worker checks the key with the lightest request of each provider and spends nothing, and works, refused and could-not-check each say what happened and what to do, in both languages and themes, with no key in any log', async ({
	h,
}) => {
	test.setTimeout(240_000);
	const key = 'sk-test-lane7-secret-value';
	const stub = await stubKeyChecks(h);
	const results: Record<string, unknown> = {};
	const contrast: { where: string; pairs: Pair[] }[] = [];
	for (const lang of langs) {
		await setLanguage(h, lang);
		for (const id of ['openrouter', 'opengateway'] as const) {
			for (const verdict of verdicts) {
				await seedProviders(h, { chosen: id });
				stub.answer.now = verdict.answer(id);
				stub.seen.length = 0;
				const settings = await openSettings(h);
				await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe(lang);
				await settings.locator('#key').fill(key);
				await settings.locator('#save').click();
				await saveTone(settings, verdict.tone);
				const shown = await settings.evaluate(() => {
					const input = document.getElementById('key') as HTMLInputElement;
					const status = document.getElementById('status') as HTMLElement;
					return {
						text: status.textContent,
						icon: getComputedStyle(status, '::before').maskImage !== 'none',
						typed: input.value !== '',
						invalid: input.getAttribute('aria-invalid'),
						focused: document.activeElement === input,
						save: (document.getElementById('save') as HTMLButtonElement).disabled,
						inHtml: document.documentElement.outerHTML.includes('lane7-secret'),
					};
				});
				results[`${lang} ${id} ${verdict.name}`] = { ...shown, stored: (await storedKey(h, id)) === key, requests: stub.seen.length };
				expect(shown.text, `${lang} ${id} ${verdict.name}`).toBe(verdict.text[lang](providerNames[id]));
				expect(shown, `${lang} ${id} ${verdict.name}`).toMatchObject({
					icon: true,
					typed: !verdict.saved,
					invalid: verdict.saved ? null : 'true',
					focused: !verdict.saved,
					save: verdict.saved,
					inHtml: false,
				});
				expect((await storedKey(h, id)) === key, `${lang} ${id} ${verdict.name} stored`).toBe(verdict.saved);
				expect(stub.seen, `${lang} ${id} ${verdict.name}`).toEqual([
					{ url: keyCheckUrls[id], method: id === 'openrouter' ? 'GET' : 'POST', authorization: `Bearer ${key}`, body: id === 'openrouter' ? null : JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-ultrafast' }) },
				]);
				for (const scheme of schemes) {
					await settings.emulateMedia({ colorScheme: scheme });
					if (id === 'opengateway') await settings.locator('#provider-section').screenshot({ path: await fresh(`p5f-keycheck-${lang}-${verdict.name}-${scheme}`), animations: 'disabled' });
					contrast.push({ where: `${lang} ${id} ${verdict.name} ${scheme}`, pairs: await settings.evaluate<Pair[]>(contrastProbe) });
				}
				await settings.close();
			}
		}
	}
	console.log(JSON.stringify(results, null, 1));
	const logged = h.logs.filter((entry) => entry.text.includes('lane7-secret'));
	expect(logged).toEqual([]);
	const checks = h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('key check'));
	console.log(checks.map((entry) => entry.text).join('\n'));
	expect(checks).toHaveLength(langs.length * 2 * verdicts.length);
	expect(contrast.flatMap(({ where, pairs }) => pairs.filter((pair) => pair.ratio < (pair.size >= 24 ? 3 : 4.5)).map((pair) => ({ where, ...pair })))).toEqual([]);
	expect(errors(h)).toEqual([]);
});

test('lane 8: a provider that never answers leaves the key unchecked within the time limit and saves it, and a key that cannot be a key is turned down without a request', async ({ h }) => {
	test.setTimeout(60_000);
	const stub = await stubKeyChecks(h);
	stub.answer.now = 'hang';
	await seedProviders(h, { chosen: 'openrouter' });
	const settings = await openSettings(h);
	await settings.locator('#key').fill('sk-test-slow-value');
	await settings.locator('#save').click();
	const checking = await settings.locator('#status').textContent();
	const whileChecking = await settings.evaluate(() => ({
		save: (document.getElementById('save') as HTMLButtonElement).disabled,
		field: (document.getElementById('key') as HTMLInputElement).readOnly,
		choice: (document.getElementById('use-other') as HTMLButtonElement).disabled,
	}));
	await settings.locator('#provider-section').screenshot({ path: await fresh('p5f-keycheck-checking'), animations: 'disabled' });
	const started = Date.now();
	await saveTone(settings, 'caution');
	const waited = Date.now() - started;
	const stored = await storedKey(h, 'openrouter');

	stub.answer.now = 200;
	stub.seen.length = 0;
	await settings.locator('#key').fill('한글로 쓴 키');
	await settings.locator('#save').click();
	await saveTone(settings, 'error');
	const refused = { requests: stub.seen.length, stored: await storedKey(h, 'openrouter'), typed: await settings.locator('#key').inputValue() };
	await settings.close();

	console.log(JSON.stringify({ checking, whileChecking, waited, stored: stored !== '', refused: { ...refused, stored: refused.stored !== '' } }));
	expect(checking).toBe('Checking the key…');
	expect(whileChecking).toEqual({ save: true, field: true, choice: true });
	expect(waited).toBeLessThan(9_000);
	expect(stored).toBe('sk-test-slow-value');
	expect(refused).toEqual({ requests: 0, stored: 'sk-test-slow-value', typed: '한글로 쓴 키' });
});

test('lane 9: add a key opens settings at the chosen provider with its key field focused, in a new tab or in the one already open, in both languages, and a reload does not ask again', async ({ headless }) => {
	test.setTimeout(120_000);
	const seen: Record<string, unknown> = {};
	for (const lang of langs) {
		const h = await launch({ headless, lang });
		try {
			await h.navigate(fixtures.wiki);
			await ready(h.page);
			const options = async () => (await h.tabUrls()).filter((url) => url.startsWith(optionsUrl(h)));
			const state = (settings: Page) =>
				settings.evaluate(() => {
					const section = (document.getElementById('provider-section') as HTMLElement).getBoundingClientRect();
					const heading = (document.getElementById('provider-heading') as HTMLElement).getBoundingClientRect();
					const active = document.activeElement as HTMLElement;
					const field = active.getBoundingClientRect();
					return {
						active: active.id,
						focus: document.hasFocus(),
						headingSeen: heading.top >= 0 && heading.bottom <= innerHeight,
						fieldSeen: field.top >= 0 && field.bottom <= innerHeight,
						sectionTop: Math.round(section.top),
						order: [...document.querySelectorAll('h2')].map((h2) => h2.id),
						marker: (window as { p5fMarker?: number }).p5fMarker ?? null,
					};
				});

			const first = await h.openPopup();
			const [settings] = await Promise.all([h.context.waitForEvent('page'), first.click('#add-key')]);
			await settings.setViewportSize({ width: 1000, height: 420 });
			await settings.waitForLoadState('load');
			await expect.poll(async () => (await state(settings)).active).toBe('key');
			seen[`${lang} new tab`] = { ...(await state(settings)), tabs: (await options()).length };
			await settings.screenshot({ path: await fresh(`p5f-add-key-${lang}`), animations: 'disabled' });

			await settings.evaluate(() => {
				Object.assign(window, { p5fMarker: 1 });
				(document.activeElement as HTMLElement).blur();
				scrollTo(0, document.documentElement.scrollHeight);
			});
			await h.page.bringToFront();
			const second = await h.openPopup();
			await second.click('#add-key');
			await expect.poll(async () => (await state(settings)).active).toBe('key');
			seen[`${lang} open tab`] = { ...(await state(settings)), tabs: (await options()).length };

			await settings.locator('#advanced > summary').click();
			await settings.locator('#use-other').click();
			await expect(settings.locator('#key-label')).toContainText('OpenRouter');
			await h.page.bringToFront();
			const third = await h.openPopup();
			await third.click('#add-key');
			await expect.poll(async () => (await state(settings)).active).toBe('key');
			seen[`${lang} other provider`] = { ...(await state(settings)), label: await settings.locator('#key-label').textContent(), tabs: (await options()).length };

			await settings.reload();
			await expect(settings.locator('#route')).not.toBeEmpty();
			await settings.waitForTimeout(200);
			seen[`${lang} reload`] = { active: (await state(settings)).active, hash: await settings.evaluate(() => location.hash) };
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	}
	console.log(JSON.stringify(seen, null, 1));
	for (const lang of langs) {
		const inView = { focus: true, headingSeen: true, fieldSeen: true, tabs: 1 };
		const sampleFirst = ['sample-heading', 'provider-heading', 'keyboard-heading', 'language-heading', 'sites-heading', 'privacy-heading'];
		expect(seen[`${lang} new tab`]).toMatchObject({ ...inView, active: 'key', order: sampleFirst });
		expect(seen[`${lang} open tab`]).toMatchObject({ ...inView, active: 'key', marker: 1 });
		expect(seen[`${lang} other provider`]).toMatchObject({ ...inView, active: 'key', marker: 1, label: lang === 'en' ? 'OpenRouter API key' : 'OpenRouter API 키' });
		expect(seen[`${lang} reload`]).toEqual({ active: '', hash: '' });
	}
});

test('lane 10: settings show only the chosen provider field and a get-a-key link, with the backup key and the model behind a closed Advanced that opens by itself when it holds something, and the page keeps still while the reader types', async ({ h }) => {
	test.setTimeout(120_000);
	const seen: Record<string, unknown> = {};
	const view = (settings: Page) =>
		settings.evaluate(() => {
			const shown = (selector: string) => document.querySelector(selector)?.checkVisibility() === true;
			const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? null;
			return {
				front: text('#key-label'),
				advanced: (document.getElementById('advanced') as HTMLDetailsElement).open,
				summary: text('#advanced > summary'),
				field: shown('#key'),
				backup: shown('#backup-key'),
				model: shown('#model'),
				link: document.querySelector<HTMLAnchorElement>('#get-key')?.href,
				linkText: text('#get-key'),
				linkTarget: document.querySelector('#get-key')?.getAttribute('target'),
				backupLabel: text('#backup-key-label'),
			};
		});
	const tops = (settings: Page) => settings.evaluate(() => [...document.querySelectorAll('h2, #save, #advanced, #key, #status')].map((el) => Math.round(el.getBoundingClientRect().top)));
	const order = (settings: Page) => settings.evaluate(() => [...document.querySelectorAll('h2')].filter((h2) => h2.checkVisibility()).map((h2) => h2.id));
	for (const lang of langs) {
		await setLanguage(h, lang);
		await seedProviders(h, undefined);
		const settings = await openSettings(h);
		await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe(lang);
		seen[`${lang} no key`] = await view(settings);
		for (const scheme of schemes) {
			await settings.emulateMedia({ colorScheme: scheme });
			await settings.screenshot({ path: await fresh(`p5f-settings-${lang}-nokey-${scheme}`), fullPage: true, animations: 'disabled' });
		}
		await settings.emulateMedia({ colorScheme: 'light' });
		await settings.setViewportSize({ width: 320, height: 720 });
		seen[`${lang} at 320 px`] = await settings.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth }));
		await settings.screenshot({ path: await fresh(`p5f-settings-${lang}-320`), fullPage: true, animations: 'disabled' });
		await settings.setViewportSize({ width: 860, height: 900 });

		await settings.locator('#key').scrollIntoViewIfNeeded();
		const before = await tops(settings);
		await settings.locator('#key').pressSequentially('typing-without-any-jump-at-all', { delay: 2 });
		const whileTyping = await tops(settings);
		await settings.locator('#key').fill('');
		await settings.locator('#advanced > summary').click();
		seen[`${lang} opened`] = await view(settings);
		await settings.locator('#provider-section').screenshot({ path: await fresh(`p5f-advanced-${lang}`), animations: 'disabled' });
		await settings.locator('#use-other').click();
		await expect(settings.locator('#key-label')).toContainText('OpenRouter');
		seen[`${lang} other provider`] = await view(settings);
		await settings.close();
		expect(whileTyping, `${lang}: typing moves nothing`).toEqual(before);

		await seedProviders(h, { chosen: 'openrouter', openrouter: { apiKey: 'or-key' } });
		const keyed = await openSettings(h);
		seen[`${lang} one key`] = { ...(await view(keyed)), order: await order(keyed) };
		await keyed.close();

		await seedProviders(h, { chosen: 'openrouter', openrouter: { apiKey: 'or-key' }, opengateway: { apiKey: 'og-key' } });
		const backed = await openSettings(h);
		seen[`${lang} backup key`] = await view(backed);
		await backed.close();

		await seedProviders(h, { chosen: 'openrouter', openrouter: { apiKey: 'or-key', model: 'other/model' } });
		const custom = await openSettings(h);
		seen[`${lang} other model`] = await view(custom);
		await custom.close();
	}
	console.log(JSON.stringify(seen, null, 1));
	const closed = { advanced: false, field: true, backup: false, model: false, link: 'https://opengateway.ai/api-keys', linkTarget: '_blank' };
	expect(seen['en no key']).toMatchObject({ ...closed, front: 'OpenGateway API key', summary: 'Advanced', linkText: 'Get an OpenGateway key' });
	expect(seen['ko no key']).toMatchObject({ ...closed, front: 'OpenGateway API 키', summary: '고급', linkText: 'OpenGateway에서 키 받기' });
	expect(seen['en opened']).toMatchObject({ advanced: true, backup: true, field: true, model: true, backupLabel: 'OpenRouter API key (backup)' });
	expect(seen['ko opened']).toMatchObject({ advanced: true, backup: true, field: true, model: true, backupLabel: 'OpenRouter API 키 (예비)' });
	for (const lang of langs) {
		expect(seen[`${lang} at 320 px`]).toEqual({ overflow: 0 });
		expect(seen[`${lang} other provider`]).toMatchObject({ field: true, link: 'https://openrouter.ai/settings/keys' });
		expect(seen[`${lang} one key`]).toMatchObject({ advanced: false, backup: false, model: false, order: ['sample-heading', 'provider-heading', 'keyboard-heading', 'language-heading', 'sites-heading', 'privacy-heading'] });
		expect(seen[`${lang} backup key`]).toMatchObject({ advanced: true, backup: true, model: true });
		expect(seen[`${lang} other model`]).toMatchObject({ advanced: true, backup: true, model: true });
	}
	expect(errors(h)).toEqual([]);
});

test('lane 11: the sections keep one order for Free with or without a key, a saved key moves nothing, and Pro and signed-out readers see the same order without what is not theirs', async ({ h }) => {
	const stub = await stubKeyChecks(h);
	stub.answer.now = 400;
	const order = (settings: Page) => settings.evaluate(() => [...document.querySelectorAll('h2')].filter((h2) => h2.checkVisibility()).map((h2) => h2.id.replace('-heading', '')));
	const seen: Record<string, string[]> = {};
	await seedProviders(h, undefined);
	const settings = await openSettings(h);
	seen.free = await order(settings);
	const before = await settings.locator('#provider-section').evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
	await settings.locator('#key').fill('sk-test-value');
	await settings.locator('#save').click();
	await saveTone(settings, 'success');
	seen['just saved'] = await order(settings);
	const after = await settings.locator('#provider-section').evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
	await settings.reload();
	await expect(settings.locator('#route')).not.toBeEmpty();
	seen['loaded again'] = await order(settings);
	await settings.close();
	await seedProviders(h, undefined);
	for (const state of ['pro', 'signedout'] as const) {
		await setAccount(h, accounts[state]);
		const page = await openSettings(h);
		seen[state] = await order(page);
		await page.close();
	}
	console.log(JSON.stringify({ seen, before, after, requests: stub.seen.length }));
	expect(seen.free).toEqual(['sample', 'provider', 'keyboard', 'language', 'sites', 'privacy']);
	expect(seen['just saved']).toEqual(seen.free);
	expect(after).toBe(before);
	expect(seen['loaded again']).toEqual(seen.free);
	expect(seen.pro).toEqual(['sample', 'keyboard', 'language', 'sites', 'privacy']);
	expect(seen.signedout).toEqual(['sample', 'keyboard', 'language', 'privacy']);
	expect(errors(h)).toEqual([]);
});

test('lane 12: save stays off until something changed, an empty save never says saved, and an emptied model is turned down', async ({ h }) => {
	const stub = await stubKeyChecks(h);
	const seen: Record<string, unknown> = {};
	for (const lang of langs) {
		await setLanguage(h, lang);
		await seedProviders(h, undefined);
		stub.seen.length = 0;
		const settings = await openSettings(h);
		const save = settings.locator('#save');
		const key = settings.locator('#key');
		const steps: Record<string, boolean> = { opened: await save.isDisabled() };
		await key.fill('   ');
		steps.spaces = await save.isDisabled();
		await key.press('Enter');
		await settings.waitForTimeout(100);
		const afterEnter = { status: await settings.locator('#status').textContent(), requests: stub.seen.length };
		await key.fill('sk-test');
		steps.typed = await save.isDisabled();
		await key.fill('');
		steps.cleared = await save.isDisabled();
		await settings.locator('#advanced > summary').click();
		const model = settings.locator('#model');
		const defaultModel = await model.inputValue();
		await model.fill('other/model');
		steps.model = await save.isDisabled();
		await model.fill(defaultModel);
		steps['model back'] = await save.isDisabled();
		await model.fill('other/model');
		await save.click();
		await saveTone(settings, 'success');
		const saved = { status: await settings.locator('#status').textContent(), requests: stub.seen.length, disabled: await save.isDisabled() };
		await model.fill('');
		steps['model emptied'] = await save.isDisabled();
		await save.click();
		await saveTone(settings, 'error');
		await model.fill(defaultModel);
		await save.click();
		await saveTone(settings, 'success');
		await settings.locator('#provider-section').screenshot({ path: await fresh(`p5f-save-idle-${lang}`), animations: 'disabled' });
		await settings.close();
		seen[lang] = { steps, afterEnter, saved };
	}
	console.log(JSON.stringify(seen, null, 1));
	const steps = { opened: true, spaces: true, typed: false, cleared: true, model: false, 'model back': true, 'model emptied': false };
	expect(seen.en).toEqual({ steps, afterEnter: { status: '', requests: 0 }, saved: { status: 'Model saved. tfold only checked how the id looks, so if AI summaries stop, check the id.', requests: 0, disabled: true } });
	expect(seen.ko).toEqual({ steps, afterEnter: { status: '', requests: 0 }, saved: { status: '모델을 저장했어요. ID의 형식만 확인했으니, AI 요약이 안 나오면 ID를 다시 확인해 보세요.', requests: 0, disabled: true } });
	expect(errors(h)).toEqual([]);
});

test('lane 13: removing a key offers undo in the status line, undo brings back the same key, a language change keeps the offer, and the offer ends after a few seconds unless the keyboard is on it', async ({ h }) => {
	test.setTimeout(120_000);
	const key = 'sk-test-lane13-secret';
	const seen: Record<string, unknown> = {};
	const undo = (settings: Page) => settings.locator('#undo');
	for (const lang of langs) {
		await setLanguage(h, lang);
		await seedProviders(h, { chosen: 'openrouter', openrouter: { apiKey: key } });
		const settings = await openSettings(h);
		await settings.locator('#remove-key').click();
		await expect(undo(settings)).toBeVisible();
		seen[`${lang} removed`] = {
			status: await settings.locator('#status').textContent(),
			undo: await undo(settings).textContent(),
			stored: await storedKey(h, 'openrouter'),
			focused: await undo(settings).evaluate((el) => document.activeElement === el),
			state: await settings.locator('#key-state').textContent(),
		};
		for (const scheme of schemes) {
			await settings.emulateMedia({ colorScheme: scheme });
			await settings.locator('#provider-section').screenshot({ path: await fresh(`p5f-undo-${lang}-${scheme}`), animations: 'disabled' });
		}
		await undo(settings).click();
		await expect(settings.locator('#remove-key')).toBeVisible();
		seen[`${lang} undone`] = { status: await settings.locator('#status').textContent(), stored: await storedKey(h, 'openrouter'), hidden: await undo(settings).isHidden() };
		await settings.close();
	}

	await seedProviders(h, { chosen: 'openrouter', openrouter: { apiKey: key } });
	const settings = await openSettings(h);
	await settings.locator('#remove-key').click();
	await expect(undo(settings)).toBeVisible();
	await setLanguage(h, 'ko');
	await expect(settings.locator('#status')).toHaveText('OpenRouter 키를 지웠어요.');
	await expect(undo(settings)).toHaveText('되돌리기');
	await setLanguage(h, 'en');
	const removedAt = Date.now();
	await settings.locator('h1').click();
	await settings.mouse.move(0, 0);
	await expect(undo(settings)).toBeHidden({ timeout: 11_000 });
	seen.expired = {
		ms: Date.now() - removedAt,
		status: await settings.locator('#status').textContent(),
		stored: await storedKey(h, 'openrouter'),
		focused: await settings.evaluate(() => document.activeElement?.id),
	};
	await settings.close();

	await seedProviders(h, { chosen: 'openrouter', openrouter: { apiKey: key } });
	const keyboard = await openSettings(h);
	await keyboard.locator('#remove-key').focus();
	await keyboard.keyboard.press('Enter');
	await expect(undo(keyboard)).toBeVisible();
	await keyboard.waitForTimeout(9_500);
	const heldByKeyboard = await undo(keyboard).isVisible();
	await keyboard.keyboard.press('Shift+Tab');
	await expect(undo(keyboard)).toBeHidden({ timeout: 3_000 });
	seen.keyboard = { heldByKeyboard, stored: await storedKey(h, 'openrouter') };
	await keyboard.close();

	console.log(JSON.stringify(seen, null, 1).replaceAll(key, '<key>'));
	expect(seen['en removed']).toEqual({ status: 'The OpenRouter key is removed.', undo: 'Undo', stored: '', focused: true, state: 'You need an OpenRouter account.' });
	expect(seen['ko removed']).toEqual({ status: 'OpenRouter 키를 지웠어요.', undo: '되돌리기', stored: '', focused: true, state: 'OpenRouter 계정이 있어야 해요.' });
	expect(seen['en undone']).toEqual({ status: 'The OpenRouter key is back.', stored: key, hidden: true });
	expect(seen['ko undone']).toEqual({ status: 'OpenRouter 키를 되돌렸어요.', stored: key, hidden: true });
	expect(seen.expired).toMatchObject({ status: '', stored: '', focused: '' });
	expect((seen.expired as { ms: number }).ms).toBeLessThan(11_000);
	expect(seen.keyboard).toEqual({ heldByKeyboard: true, stored: '' });
	expect(errors(h)).toEqual([]);
});

test('lane 14: the fold-into-my-language switch turns off with a one-line reason when there is no model route, keeps the stored choice, and works on Pro and with a key, in both languages and themes', async ({ h }) => {
	test.setTimeout(120_000);
	const seen: Record<string, unknown> = {};
	const contrast: { where: string; pairs: Pair[] }[] = [];
	await worker(h).evaluate(() => chrome.storage.sync.set({ autoTranslate: true }));
	const read = (settings: Page) =>
		settings.evaluate(() => {
			const toggle = document.getElementById('auto-translate') as HTMLButtonElement;
			const reason = document.getElementById('auto-translate-reason') as HTMLElement;
			return { disabled: toggle.disabled, checked: toggle.getAttribute('aria-checked'), reason: reason.checkVisibility() ? reason.textContent : null };
		});
	for (const lang of langs) {
		await setLanguage(h, lang);
		for (const [name, account, keyed] of [
			['free no key', accounts.free, false],
			['free with key', accounts.free, true],
			['pro no key', accounts.pro, false],
			['signed out', accounts.signedout, false],
		] as const) {
			await setAccount(h, account);
			await seedProviders(h, keyed ? { chosen: 'openrouter', openrouter: { apiKey: 'or-key' } } : undefined);
			const settings = await openSettings(h);
			await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe(lang);
			seen[`${lang} ${name}`] = await read(settings);
			for (const scheme of schemes) {
				await settings.emulateMedia({ colorScheme: scheme });
				if (name === 'free no key') await settings.locator('#language-section').screenshot({ path: await fresh(`p5f-translate-off-${lang}-${scheme}`), animations: 'disabled' });
				contrast.push({ where: `${lang} ${name} ${scheme}`, pairs: await settings.evaluate<Pair[]>(contrastProbe) });
			}
			await settings.close();
		}
	}
	await setAccount(h, accounts.free);
	await seedProviders(h, undefined);
	const settings = await openSettings(h);
	await settings.locator('#auto-translate').click({ force: true }).catch(() => undefined);
	const storedWhileOff = await worker(h).evaluate(() => chrome.storage.sync.get('autoTranslate'));
	await settings.close();

	console.log(JSON.stringify(seen, null, 1));
	const off = (reason: string) => ({ disabled: true, checked: 'false', reason });
	const on = { disabled: false, checked: 'true', reason: null };
	expect(seen['en free no key']).toEqual(off('Save a key to use this.'));
	expect(seen['ko free no key']).toEqual(off('키를 저장하면 쓸 수 있어요.'));
	expect(seen['en signed out']).toEqual(off('Sign in to use this.'));
	expect(seen['ko signed out']).toEqual(off('로그인하면 쓸 수 있어요.'));
	for (const lang of langs) {
		expect(seen[`${lang} free with key`]).toEqual(on);
		expect(seen[`${lang} pro no key`]).toEqual(on);
	}
	expect(storedWhileOff).toEqual({ autoTranslate: true });
	expect(contrast.flatMap(({ where, pairs }) => pairs.filter((pair) => pair.ratio < (pair.size >= 24 ? 3 : 4.5)).map((pair) => ({ where, ...pair })))).toEqual([]);
	expect(errors(h)).toEqual([]);
});

const smallTargets = `[...document.querySelectorAll('button, a[href], summary, input:not([type="radio"]), [role="switch"]')]
	.filter((el) => el.checkVisibility())
	.map((el) => ({ el, box: el.getBoundingClientRect() }))
	.filter(({ box }) => box.height < 24 || box.width < 24)
	.map(({ el, box }) => [el.id || el.textContent.trim(), Math.round(box.width), Math.round(box.height)])`;

test('lane 15: controls are at least 24 px, text buttons have rounded focus rings, the shortcut buttons name their shortcut, disabled looks disabled, tones differ by icon as well as color, and settings wears the same mark and wordmark as the popup', async ({ h }) => {
	test.setTimeout(180_000);
	const stub = await stubKeyChecks(h);
	const small: Record<string, unknown> = {};
	await h.navigate(fixtures.wiki);
	await ready(h.page);
	const popup = await h.openPopup();
	for (const lang of langs) {
		await setLanguage(h, lang);
		for (const state of ['signedout', 'free', 'pro'] as const) {
			await setAccount(h, accounts[state]);
			await expect.poll(async () => (await readPopup(popup)).lang).toBe(lang);
			await popup.evaluate('new Promise((resolve) => setTimeout(resolve, 80))');
			small[`popup ${lang} ${state}`] = await popup.evaluate(smallTargets);
		}
	}
	await setAccount(h, accounts.free);
	await expect.poll(async () => (await readPopup(popup)).shown).toEqual(popupParts.free);
	const popupBrand = await popup.evaluate<Record<string, number[]>>(`(() => {
		const size = (selector) => { const box = document.querySelector(selector).getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; };
		return { mark: size('.mark'), wordmark: size('.wordmark') };
	})()`);
	const settingsRadius = await popup.evaluate<string>(`getComputedStyle(document.getElementById('settings')).borderTopLeftRadius`);
	await popup.close();

	await setLanguage(h, 'en');
	await seedProviders(h, { chosen: 'openrouter', openrouter: { apiKey: 'or-key' }, opengateway: { apiKey: 'og-key' } });
	const settings = await openSettings(h);
	for (const lang of langs) {
		await setLanguage(h, lang);
		await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe(lang);
		small[`settings ${lang}`] = await settings.evaluate(smallTargets);
	}
	const koLabels = await settings.evaluate(() => [...document.querySelectorAll('[data-change]')].map((button) => button.getAttribute('aria-label')));
	await setLanguage(h, 'en');
	await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe('en');
	const labels = await settings.evaluate(() => [...document.querySelectorAll('[data-change]')].map((button) => button.getAttribute('aria-label')));
	await settings.locator('[data-change="fold"]').click();
	const recording = await settings.locator('[data-change="fold"]').getAttribute('aria-label');
	await settings.keyboard.press('Escape');

	const radius = await settings.evaluate(() => Object.fromEntries(['#remove-key', '#get-backup-key', '#advanced > summary'].map((selector) => [selector, parseFloat(getComputedStyle(document.querySelector(selector) as Element).borderTopLeftRadius)])));
	const brand = await settings.evaluate(() => {
		const size = (selector: string) => {
			const box = (document.querySelector(selector) as Element).getBoundingClientRect();
			return [Math.round(box.width), Math.round(box.height)];
		};
		return { mark: size('.top .mark'), wordmark: size('.top .wordmark'), loaded: (document.querySelector('.top .mark') as HTMLImageElement).naturalWidth > 0 };
	});
	await settings.mouse.move(0, 0);
	const buttonLook = await settings.evaluate(async () => {
		await Promise.all(document.getAnimations().map((animation) => animation.finished));
		const look = (el: Element) => {
			const style = getComputedStyle(el);
			return { background: style.backgroundColor, border: style.borderTopColor, cursor: style.cursor };
		};
		return { disabled: look(document.getElementById('default-keys') as Element), save: look(document.getElementById('save') as Element), enabled: look(document.querySelector('[data-change="fold"]') as Element) };
	});
	await settings.locator('#default-keys').hover();
	const disabledHover = await settings.locator('#default-keys').evaluate(async (el) => {
		await Promise.all(el.getAnimations().map((animation) => animation.finished));
		return getComputedStyle(el).backgroundColor;
	});
	await settings.locator('#provider-section').screenshot({ path: await fresh('p5f-settings-keyed-section'), animations: 'disabled' });
	await settings.locator('#keyboard').screenshot({ path: await fresh('p5f-keyboard'), animations: 'disabled' });

	const tones: Record<string, { color: string; icon: string; weight: string }> = {};
	for (const [tone, status] of [['error', 401], ['caution', 503], ['success', 200]] as const) {
		stub.answer.now = status;
		await settings.locator('#key').fill('sk-test');
		await settings.locator('#save').click();
		await saveTone(settings, tone);
		tones[tone] = await settings.locator('#status').evaluate((el) => {
			const before = getComputedStyle(el, '::before');
			return { color: getComputedStyle(el).color, icon: before.maskImage, weight: getComputedStyle(el).fontWeight };
		});
	}
	await settings.close();

	console.log(JSON.stringify({ small, labels, koLabels, recording, radius, brand, popupBrand, buttonLook, disabledHover, settingsRadius, tones: Object.fromEntries(Object.entries(tones).map(([tone, { color, weight, icon }]) => [tone, { color, weight, icon: icon.length }])) }, null, 1));
	for (const [where, targets] of Object.entries(small)) expect(targets, where).toEqual([]);
	expect(labels).toEqual(['Change the shortcut for Fold one level', 'Change the shortcut for Unfold one level']);
	expect(koLabels).toEqual(['한 단계 접기 단축키 바꾸기', '한 단계 펼치기 단축키 바꾸기']);
	expect(recording).toBe('Press the new shortcut for Fold one level');
	for (const value of [...Object.values(radius), parseFloat(settingsRadius)]) expect(value).toBeGreaterThanOrEqual(6);
	expect(brand).toEqual({ ...popupBrand, loaded: true });
	expect(buttonLook.disabled.background).not.toBe(buttonLook.enabled.background);
	expect(buttonLook.disabled.cursor).toBe('not-allowed');
	expect(buttonLook.save).toEqual(buttonLook.disabled);
	expect(disabledHover).toBe(buttonLook.disabled.background);
	const icons = new Set(Object.values(tones).map(({ icon }) => icon));
	expect(icons.size).toBe(3);
	expect(icons.has('none')).toBe(false);
	expect(new Set(Object.values(tones).map(({ color }) => color)).size).toBe(3);
	expect(errors(h)).toEqual([]);
});

test('lane 16: settings and the popup name Ctrl and scroll beside the fold and the shortcut, in both languages and on Mac labels, and a Ctrl wheel down folds and up unfolds as they say', async ({ headless }) => {
	test.setTimeout(180_000);
	const seen: Record<string, unknown> = {};
	const paragraph = `${wikiParagraphs} >> nth=1`;
	for (const lang of langs) {
		const h = await launch({ headless, lang });
		try {
			await worker(h).evaluate(() => chrome.storage.local.set({ hintSeen: true }));
			await h.navigate(fixtures.wiki);
			await ready(h.page);

			const popup = await h.openPopup();
			const inPopup = await popup.evaluate<Record<string, string | null>>(`({
				how: document.querySelector('#how-title').textContent,
				scrollKeys: document.getElementById('scroll-keys').textContent,
			})`);
			await popup.close();

			const settings = await openSettings(h);
			const inSettings = await settings.evaluate(() => {
				const row = document.getElementById('scroll-row') as HTMLElement;
				return {
					intro: document.getElementById('sample-hint')?.textContent?.replace(/\s+/g, ' ').trim(),
					hint: document.getElementById('keyboard-hint')?.textContent,
					keys: document.querySelector('input[name="scroll-modifier"]:checked')?.parentElement?.textContent,
					rowText: (row.querySelector('dt') as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
					buttons: row.querySelectorAll('button').length,
					rows: document.querySelectorAll('#shortcuts .row').length,
				};
			});
			await settings.locator('#keyboard').screenshot({ path: await fresh(`p5f-ways-to-fold-${lang}`), animations: 'disabled' });
			await settings.close();

			await h.page.bringToFront();
			const { x, y } = await h.pointAt(paragraph);
			const levels = [(await h.readBlocks()).filter((block) => block.level !== 0).length];
			await h.foldAt(x, y, 1);
			await h.page.waitForTimeout(500);
			levels.push((await h.readBlocks()).filter((block) => block.level !== 0).length);
			const point = await h.pointAt('[data-tfold-overlay]');
			await h.foldAt(point.x, point.y, -1);
			await h.page.waitForTimeout(500);
			levels.push((await h.readBlocks()).filter((block) => block.level !== 0).length);
			seen[lang] = { inPopup, inSettings, levels };

			await h.context.addInitScript(`Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })`);
			const mac = await openSettings(h);
			seen[`${lang} mac`] = await mac.evaluate(() => ({
				keys: document.querySelector('input[name="scroll-modifier"]:checked')?.parentElement?.textContent,
				intro: document.getElementById('sample-hint')?.querySelector('kbd')?.textContent,
				hint: document.getElementById('scroll-hint')?.textContent,
			}));
			await mac.locator('#keyboard').screenshot({ path: await fresh(`p5f-ways-to-fold-${lang}-mac`), animations: 'disabled' });
			await mac.close();
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	}
	console.log(JSON.stringify(seen, null, 1));
	expect(seen.en).toMatchObject({
		inPopup: { how: 'Hold Ctrl and a green line marks the paragraph, then scroll. Or use the shortcut.', scrollKeys: 'Ctrl+scroll ↓ ↑' },
		inSettings: { keys: 'Ctrl', rowText: 'Scroll down to fold, up to unfold', buttons: 0, rows: 3 },
		levels: [0, 1, 0],
	});
	expect((seen.en as { inSettings: { intro: string; hint: string } }).inSettings.intro).toBe('Point at the paragraph, hold Ctrl and scroll down.');
	expect(seen.ko).toMatchObject({
		inPopup: { how: 'Ctrl 누르고 있으면 문단 옆에 초록 선이 나와요. 그대로 스크롤하면 접혀요. 아래 단축키로도 접을 수 있어요.', scrollKeys: 'Ctrl+스크롤 ↓ ↑' },
		inSettings: { keys: 'Ctrl', rowText: '아래로 스크롤해 접고, 위로 펼치기', buttons: 0, rows: 3 },
		levels: [0, 1, 0],
	});
	expect((seen.ko as { inSettings: { intro: string; hint: string } }).inSettings.intro).toBe('문단에 포인터를 올리고 Ctrl 키를 누른 채 아래로 스크롤해 보세요.');
	expect(seen['en mac']).toEqual({ keys: 'Cmd', intro: 'Cmd', hint: en.scrollHintMac });
	expect(seen['ko mac']).toEqual({ keys: 'Cmd', intro: 'Cmd', hint: ko.scrollHintMac });
});

const liveKeys = { openrouter: process.env.OPENROUTER_API_KEY ?? '', opengateway: process.env.OPENGATEWAY_API_KEY ?? '' };

test.describe('live key check', () => {
	test.use({ allowLiveHosts: ['openrouter.ai', 'apis.opengateway.ai'] });
	test.skip(liveKeys.openrouter === '' || liveKeys.opengateway === '', 'OPENROUTER_API_KEY and OPENGATEWAY_API_KEY are not set');

	test('lane 17: each provider answers a real key as works and a bad key as refused, a 9 KB key never leaves the page, and no token is spent', async ({ h }) => {
		const seen: Record<string, unknown> = {};
		for (const id of ['openrouter', 'opengateway'] as const) {
			await seedProviders(h, { chosen: id });
			const settings = await openSettings(h);
			await settings.locator('#key').fill('a'.repeat(9 * 1024));
			await settings.locator('#save').click();
			await saveTone(settings, 'error');
			const hugeStored = (await storedKey(h, id)) !== '';
			await settings.locator('#key').fill('tfold-lane-bad-key');
			await settings.locator('#save').click();
			await expect(settings.locator('#status')).toContainText('refused', { timeout: 12_000 });
			const stored = (await storedKey(h, id)) !== '';
			await settings.locator('#key').fill(liveKeys[id]);
			await settings.locator('#save').click();
			await saveTone(settings, 'success');
			seen[id] = { hugeKeyStored: hugeStored, badKeyStored: stored, goodKeyStored: (await storedKey(h, id)) === liveKeys[id], fieldCleared: (await settings.locator('#key').inputValue()) === '' };
			await settings.close();
		}
		const lines = h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('key check')).map((entry) => entry.text);
		console.log(JSON.stringify(seen));
		console.log(lines.join('\n'));
		const shape = { hugeKeyStored: false, badKeyStored: false, goodKeyStored: true, fieldCleared: true };
		expect(seen).toEqual({ openrouter: shape, opengateway: shape });
		expect(lines).toEqual([
			expect.stringMatching(/^key check openrouter, refused, HTTP 401, \d+ ms$/),
			expect.stringMatching(/^key check openrouter, works, HTTP 200, \d+ ms$/),
			expect.stringMatching(/^key check opengateway, refused, HTTP 401, \d+ ms$/),
			expect.stringMatching(/^key check opengateway, works, HTTP 400, \d+ ms$/),
		]);
		expect(h.logs.filter((entry) => entry.text.includes(liveKeys.openrouter) || entry.text.includes(liveKeys.opengateway)).length).toBe(0);
		expect(errors(h)).toEqual([]);
	});

	test('lane 18: a real OpenGateway key reads as works on every save through the settings page', async ({ h }) => {
		test.setTimeout(120_000);
		const tones: (string | null)[] = [];
		for (let save = 0; save < 12; save++) {
			await seedProviders(h, undefined);
			const settings = await openSettings(h);
			await settings.locator('#key').fill(liveKeys.opengateway);
			await settings.locator('#save').click();
			await expect(settings.locator('#status')).toHaveAttribute('data-tone', /success|caution|error/, { timeout: 12_000 });
			tones.push(await settings.locator('#status').getAttribute('data-tone'));
			await settings.close();
		}
		const lines = h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('key check')).map((entry) => entry.text);
		console.log(lines.join('\n'));
		expect(tones).toEqual(Array.from({ length: 12 }, () => 'success'));
		expect(lines).toEqual(Array.from({ length: 12 }, () => expect.stringMatching(/^key check opengateway, works, HTTP 400, \d+ ms$/)));
		expect(h.logs.filter((entry) => entry.text.includes(liveKeys.opengateway)).length).toBe(0);
		expect(errors(h)).toEqual([]);
	});
});
