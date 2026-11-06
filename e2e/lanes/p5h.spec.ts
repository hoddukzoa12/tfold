import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { signInUrl, type Account } from '../../src/account.ts';
import { localFold } from '../../src/fold/local.ts';
import { en, enStore } from '../../src/strings/en.ts';
import { ko, koStore } from '../../src/strings/ko.ts';
import { contrastProbe, type Pair } from '../contrast.ts';
import { extensionDir, fixtures, launch, foldAt, type Harness } from '../harness.ts';
import { expect, test } from '../lane.ts';
import { openGatewayKeyReply, openRouterKeyReply } from '../provider-replies.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p5h');

type Lang = 'en' | 'ko';
type ProviderId = 'openrouter' | 'opengateway';
type Reply = { status: number; body?: string | ((sent: string | null) => string); contentType?: string } | 'abort' | 'hang' | 'gate';
type Settled = Exclude<Reply, 'hang' | 'gate'>;

const langs: Lang[] = ['en', 'ko'];
const storeTables = { en: enStore, ko: koStore };
const worker = (h: Harness) => h.context.serviceWorkers().at(-1) ?? h.worker;
const optionsUrl = (h: Harness) => `chrome-extension://${h.extensionId}/options/options.html`;
const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const keyCheckLines = (h: Harness) => h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('key check')).map((entry) => entry.text);

async function fresh(slug: string): Promise<string> {
	const file = path.join(outDir, `${slug}.png`);
	await mkdir(outDir, { recursive: true });
	await rm(file, { force: true });
	return file;
}

const urls: Record<ProviderId, string> = { openrouter: 'https://openrouter.ai/api/v1/key', opengateway: 'https://apis.opengateway.ai/v1/chat/completions' };
const works: Record<ProviderId, Settled> = {
	openrouter: { status: 200, body: openRouterKeyReply },
	opengateway: { status: 400, body: openGatewayKeyReply },
};
const refused: Settled = { status: 401, body: '{"error":{"code":"invalid_api_key"}}' };
const tomcat400 = '<!doctype html><html lang="en"><head><title>HTTP Status 400 – Bad Request</title></head></html>';

async function stubKeyChecks(h: Harness) {
	const seen: ProviderId[] = [];
	const answer: Record<ProviderId, Reply> = { ...works };
	let open: (reply: Settled) => void = () => {};
	const fulfil = (route: Parameters<Parameters<Harness['context']['route']>[1]>[0], reply: Settled) =>
		reply === 'abort'
			? route.abort('connectionfailed')
			: route.fulfill({ status: reply.status, body: typeof reply.body === 'function' ? reply.body(route.request().postData()) : (reply.body ?? ''), contentType: reply.contentType ?? 'application/json' });
	for (const id of ['openrouter', 'opengateway'] as const) {
		await h.context.route(urls[id], async (route) => {
			seen.push(id);
			const reply = answer[id];
			if (reply === 'hang') return;
			await fulfil(route, reply === 'gate' ? await new Promise<Settled>((resolve) => (open = resolve)) : reply);
		});
	}
	return { seen, answer, release: (reply: Settled) => open(reply) };
}

const seedProviders = (h: Harness, providers: object | undefined) =>
	worker(h).evaluate((providers) => (providers ? chrome.storage.local.set({ providers }) : chrome.storage.local.remove('providers')), providers);

const storedKey = (h: Harness, id: ProviderId) =>
	worker(h).evaluate(async (id) => ((await chrome.storage.local.get('providers')).providers as Record<string, { apiKey?: string } | undefined> | undefined)?.[id]?.apiKey ?? '', id);

async function openSettings(h: Harness, width = 860, height = 900): Promise<Page> {
	const settings = await h.context.newPage();
	await settings.setViewportSize({ width, height });
	await settings.goto(optionsUrl(h));
	await expect(settings.locator('#route')).not.toBeEmpty();
	return settings;
}

const saveTone = (settings: Page, tone: string) => expect(settings.locator('#status')).toHaveAttribute('data-tone', tone, { timeout: 12_000 });

test('lane 1: only the reply a provider gives a real key reads as works, a refusal stays refused, and everything else saves as could not check', async ({ h }) => {
	test.setTimeout(180_000);
	const stub = await stubKeyChecks(h);
	const shared: [string, Reply, string][] = [
		['401 with an HTML body', { status: 401, body: '<html>no</html>', contentType: 'text/html' }, 'error'],
		['403', { status: 403, body: '{}' }, 'error'],
		['402', { status: 402, body: '{}' }, 'caution'],
		['429', { status: 429, body: '{}' }, 'caution'],
		['503 HTML', { status: 503, body: '<html>down</html>', contentType: 'text/html' }, 'caution'],
		['offline', 'abort', 'caution'],
	];
	const table: Record<ProviderId, [string, Reply, string][]> = {
		openrouter: [
			['the real reply', works.openrouter, 'success'],
			['200 from a captive portal', { status: 200, body: '<html>sign in to the wifi</html>', contentType: 'text/html' }, 'caution'],
			['200 empty', { status: 200, body: '' }, 'caution'],
			['200 with no data', { status: 200, body: '{"error":"nope"}' }, 'caution'],
			['the other provider reply', works.opengateway, 'caution'],
			...shared,
		],
		opengateway: [
			['the real reply', works.opengateway, 'success'],
			['400 from the server in front', { status: 400, body: tomcat400, contentType: 'text/html;charset=utf-8' }, 'caution'],
			['400 empty', { status: 400, body: '' }, 'caution'],
			['400 about something else', { status: 400, body: '{"error":{"type":"invalid_request_error","message":"header too large"}}' }, 'caution'],
			['the other provider reply', works.openrouter, 'caution'],
			...shared,
		],
	};
	const seen: Record<string, unknown> = {};
	for (const id of ['openrouter', 'opengateway'] as const) {
		for (const [name, reply, tone] of table[id]) {
			await seedProviders(h, { chosen: id });
			stub.answer[id] = reply;
			const settings = await openSettings(h);
			await settings.locator('#key').fill('sk-test-state');
			await settings.locator('#save').click();
			await saveTone(settings, tone);
			const stored = (await storedKey(h, id)) === 'sk-test-state';
			seen[`${id} ${name}`] = { tone, stored };
			expect(stored, `${id} ${name} stored`).toBe(tone !== 'error');
			await settings.close();
		}
	}
	console.log(JSON.stringify(seen, null, 1));
	expect(h.logs.filter((entry) => entry.text.includes('sk-test-state'))).toEqual([]);
	expect(errors(h)).toEqual([]);
});

test('lane 3: with settings open in another window, add a key and open settings each reach that one tab and focus its window, add a key focuses the field, and the typing stays', async ({ headless }) => {
	test.setTimeout(120_000);
	const seen: Record<string, unknown> = {};
	for (const lang of langs) {
		const h = await launch({ headless, lang });
		try {
			await h.navigate(fixtures.wiki);
			const made = await worker(h).evaluate(async (url) => (await chrome.windows.create({ url, focused: false }))?.id, optionsUrl(h));
			await expect.poll(() => h.context.pages().some((page) => page.url().startsWith(optionsUrl(h)))).toBe(true);
			const settings = h.context.pages().find((page) => page.url().startsWith(optionsUrl(h))) as Page;
			await expect(settings.locator('#route')).not.toBeEmpty();
			await settings.evaluate(() => {
				Object.assign(window, { p5hMarker: 1 });
				(document.getElementById('key') as HTMLInputElement).value = 'sk-typed-kept';
			});
			const place = async (via: string) => {
				await h.page.bringToFront();
				await worker(h).evaluate(async () => {
					const [tab] = await chrome.tabs.query({ url: 'http://*/*' });
					if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
				});
				await settings.evaluate(() => (document.activeElement as HTMLElement).blur());
				const popup = await h.openPopup();
				await popup.click(via);
				await settings.waitForTimeout(600);
				const windows = await worker(h).evaluate(async () => (await chrome.windows.getAll()).filter((window) => window.focused).map((window) => window.id));
				const view = await settings.evaluate(() => ({
					marker: (window as { p5hMarker?: number }).p5hMarker ?? null,
					active: document.activeElement?.id,
					typed: (document.getElementById('key') as HTMLInputElement).value,
					hash: location.hash,
				}));
				return { tabs: (await h.tabUrls()).filter((url) => url.startsWith(optionsUrl(h))).length, windowFocused: windows.includes(made), ...view };
			};
			seen[`${lang} add a key`] = await place('#add-key');
			seen[`${lang} add a key again`] = await place('#add-key');
			seen[`${lang} open settings`] = await place('#settings');
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	}
	console.log(JSON.stringify(seen, null, 1));
	const kept = { tabs: 1, windowFocused: true, marker: 1, typed: 'sk-typed-kept', hash: '' };
	for (const lang of langs) {
		expect(seen[`${lang} add a key`]).toEqual({ ...kept, active: 'key' });
		expect(seen[`${lang} add a key again`]).toEqual({ ...kept, active: 'key' });
		expect(seen[`${lang} open settings`]).toEqual({ ...kept, active: '' });
	}
});

test('lane 4: undo restores a removed key only while storage still holds what the removal left, and a key saved in another tab ends the offer there at once', async ({ h }) => {
	await stubKeyChecks(h);
	const old = { chosen: 'opengateway', opengateway: { apiKey: 'sk-old-og' } };
	const undoHidden = (settings: Page) => expect(settings.locator('#undo')).toBeHidden();

	await seedProviders(h, old);
	const first = await openSettings(h);
	const second = await openSettings(h);
	await first.bringToFront();
	await first.locator('#remove-key').click();
	await expect(first.locator('#undo')).toBeVisible();
	await expect(second.locator('#remove-key')).toBeHidden();
	await second.bringToFront();
	await second.locator('#key').fill('sk-new-og');
	await second.locator('#save').click();
	await saveTone(second, 'success');
	await first.bringToFront();
	await undoHidden(first);
	await expect(first.locator('#status')).toBeEmpty();
	await expect(first.locator('#remove-key')).toBeVisible();
	expect(await storedKey(h, 'opengateway')).toBe('sk-new-og');
	await second.close();

	await seedProviders(h, old);
	await first.reload();
	await expect(first.locator('#route')).not.toBeEmpty();
	await first.locator('#remove-key').click();
	await expect(first.locator('#undo')).toBeVisible();
	await first.evaluate(() => {
		void chrome.storage.local.set({ providers: { chosen: 'opengateway', opengateway: { apiKey: 'sk-new-og' } } });
		(document.getElementById('undo') as HTMLButtonElement).click();
	});
	await undoHidden(first);
	await first.waitForTimeout(200);
	expect(await storedKey(h, 'opengateway')).toBe('sk-new-og');

	await seedProviders(h, old);
	await first.reload();
	await expect(first.locator('#route')).not.toBeEmpty();
	await first.locator('#remove-key').click();
	await expect(first.locator('#undo')).toBeVisible();
	await worker(h).evaluate(() => chrome.storage.local.set({ providers: { chosen: 'opengateway', opengateway: { apiKey: '' }, openrouter: { apiKey: 'sk-other-or' } } }));
	await first.waitForTimeout(200);
	await expect(first.locator('#undo')).toBeVisible();
	await first.locator('#undo').click();
	await expect.poll(() => storedKey(h, 'opengateway')).toBe('sk-old-og');
	expect(await storedKey(h, 'openrouter')).toBe('sk-other-or');
	await first.close();
	expect(errors(h)).toEqual([]);
});

test('lane 5: while a key is being checked, removal, the other service and the fields are off and the page says it is checking, so nothing writes a removed key back or loses a saved one', async ({ h }) => {
	const stub = await stubKeyChecks(h);
	const both = { chosen: 'openrouter', openrouter: { apiKey: 'sk-old-or' }, opengateway: { apiKey: 'sk-old-og' } };
	const storedChoice = () => worker(h).evaluate(async () => ((await chrome.storage.local.get('providers')).providers as { chosen?: string }).chosen);
	const view = (settings: Page) =>
		settings.evaluate(() => ({
			status: document.getElementById('status')?.textContent,
			removeChosen: (document.getElementById('remove-key') as HTMLButtonElement).disabled,
			removeBackup: (document.getElementById('remove-backup-key') as HTMLButtonElement).disabled,
			undo: (document.getElementById('undo') as HTMLButtonElement).hidden,
			busy: document.getElementById('provider')?.getAttribute('aria-busy'),
		}));
	const typing = async (settings: Page) => {
		const values: string[] = [];
		for (const field of ['#key', '#backup-key', '#model']) {
			await settings.locator(field).focus();
			await settings.keyboard.type('x');
			values.push(await settings.locator(field).inputValue());
		}
		return values;
	};

	await seedProviders(h, both);
	stub.answer.openrouter = 'gate';
	const settings = await openSettings(h);
	const model = await settings.locator('#model').inputValue();
	await settings.locator('#key').fill('sk-new-or');
	await settings.locator('#save').click();
	await expect.poll(() => stub.seen.length).toBe(1);
	const checking = await view(settings);
	const typedWhileChecking = await typing(settings);
	await settings.locator('#remove-key').click({ force: true, timeout: 500 }).catch(() => undefined);
	await settings.locator('#remove-backup-key').click({ force: true, timeout: 500 }).catch(() => undefined);
	await settings.locator('#use-other').click({ force: true, timeout: 500 }).catch(() => undefined);
	expect(await storedKey(h, 'openrouter')).toBe('sk-old-or');
	expect(await storedKey(h, 'opengateway')).toBe('sk-old-og');
	expect(typedWhileChecking, 'no field takes typing during a check').toEqual(['sk-new-or', '', model]);
	expect(await storedChoice(), 'the other service stays off during a check').toBe('openrouter');
	stub.release(works.openrouter);
	await saveTone(settings, 'success');
	const done = await view(settings);
	expect(await storedKey(h, 'openrouter')).toBe('sk-new-or');
	expect(await storedKey(h, 'opengateway')).toBe('sk-old-og');
	expect(await storedChoice()).toBe('openrouter');
	await settings.close();

	await seedProviders(h, both);
	stub.seen.length = 0;
	const offered = await openSettings(h);
	await offered.locator('#remove-key').click();
	await expect(offered.locator('#undo')).toBeVisible();
	await offered.locator('#key').fill('sk-new-or');
	await offered.locator('#save').click();
	await expect.poll(() => stub.seen.length).toBe(1);
	const checkingAfterRemoval = await view(offered);
	stub.release(refused);
	await saveTone(offered, 'error');
	expect(await storedKey(h, 'openrouter')).toBe('');
	const afterRefusal = { undo: await offered.locator('#undo').isHidden(), remove: await offered.locator('#remove-backup-key').isDisabled() };
	await offered.close();

	console.log(JSON.stringify({ checking, done, checkingAfterRemoval, afterRefusal }));
	const off = { status: 'Checking the key…', removeChosen: true, removeBackup: true, undo: true, busy: 'true' };
	expect(checking).toEqual(off);
	expect(done).toMatchObject({ removeChosen: false, removeBackup: false, busy: 'false' });
	expect(checkingAfterRemoval).toEqual(off);
	expect(afterRefusal).toEqual({ undo: true, remove: false });
	expect(errors(h)).toEqual([]);
});

test('lane 6: only the settings page gets a key check: a content script and the popup get no answer that means anything and send no request', async ({ h }) => {
	const stub = await stubKeyChecks(h);
	await seedProviders(h, { chosen: 'openrouter', openrouter: { apiKey: 'sk-test-stored' } });
	await h.navigate(fixtures.wiki);
	await expect.poll(() => h.inContent('typeof chrome.runtime.sendMessage').catch(() => null)).toBe('function');
	const fromContent = await h.inContent(`chrome.runtime.sendMessage({ type: 'check-key', provider: 'openrouter', apiKey: 'sk-test-typed' })`);
	const popup = await h.openPopup();
	const fromPopup = await popup.evaluate(`chrome.runtime.sendMessage({ type: 'check-key', provider: 'openrouter', apiKey: 'sk-test-typed' })`);
	await popup.close();
	await h.page.waitForTimeout(300);
	expect({ fromContent, fromPopup, requests: stub.seen.length, checks: keyCheckLines(h).length }).toEqual({ fromContent: 'unknown', fromPopup: 'unknown', requests: 0, checks: 0 });

	const settings = await openSettings(h);
	const fromSettings = await settings.evaluate(() => chrome.runtime.sendMessage<unknown, string>({ type: 'check-key', provider: 'openrouter', apiKey: 'sk-test-typed' }));
	await settings.close();
	expect({ fromSettings, requests: stub.seen.length }).toEqual({ fromSettings: 'works', requests: 1 });
	expect(h.logs.filter((entry) => entry.text.includes('sk-test-'))).toEqual([]);
	expect(errors(h)).toEqual([]);
});

test('lane 7: saving a new key in the same tab ends the undo offer for every verdict that saves, and the old key never comes back', async ({ h }) => {
	const stub = await stubKeyChecks(h);
	for (const [name, reply, tone] of [
		['works', works.opengateway, 'success'],
		['could not check', { status: 503, body: '' }, 'caution'],
	] as const) {
		await seedProviders(h, { chosen: 'opengateway', opengateway: { apiKey: 'sk-old-og' } });
		stub.answer.opengateway = reply;
		const settings = await openSettings(h);
		await settings.locator('#remove-key').click();
		await expect(settings.locator('#undo')).toBeVisible();
		await settings.locator('#key').fill('sk-new-og');
		await settings.locator('#save').click();
		await saveTone(settings, tone);
		await expect(settings.locator('#undo'), name).toBeHidden();
		expect(await storedKey(h, 'opengateway'), name).toBe('sk-new-og');
		await settings.close();
	}
	expect(errors(h)).toEqual([]);
});

const label63 = 'a-very-long-subdomain-label-that-goes-on-and-on-for-sixty-three';
const hosts = {
	short: 'example.com',
	'30 characters': 'thirty-characters-long.example',
	'253 characters': `${label63}.${label63}.${label63}.${label63.slice(0, 49)}.example.com`,
};
const longest = {
	fold: { code: 'ArrowDown', ctrl: true, alt: true, shift: true, meta: true },
	unfold: { code: 'ArrowUp', ctrl: true, alt: true, shift: true, meta: true },
};
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const popupStates: Record<string, Account> = {
	'pro trial ending, low': { kind: 'pro', trialEndsAt: inDays(1), remainingPercent: 8, resetsAt: inDays(20) },
	'pro, empty, trial ending': { kind: 'pro', trialEndsAt: inDays(1), remainingPercent: 0, resetsAt: inDays(20) },
	'pro, plenty': { kind: 'pro', remainingPercent: 72, resetsAt: inDays(20) },
	'free, no key': { kind: 'free' },
	'signed out': { kind: 'signedOut' },
};
const popupFit = `(() => {
	const root = document.documentElement;
	const body = document.body.getBoundingClientRect();
	const host = document.getElementById('site-host');
	const shown = host.checkVisibility();
	const spilled = [...document.querySelectorAll('kbd, .row-title, .row-hint, .button, .row, main, footer')].filter((el) => el.checkVisibility() && el.getBoundingClientRect().right > 320).map((el) => el.id || el.className || el.localName);
	root.scrollTop = root.scrollHeight;
	const last = [...document.querySelectorAll('#settings, #try-first')].find((el) => el.checkVisibility());
	const reachable = last.getBoundingClientRect().bottom <= innerHeight + 1;
	root.scrollTop = 0;
	return {
		innerWidth,
		bodyWidth: Math.ceil(body.width),
		scrollWidth: root.scrollWidth,
		height: Math.ceil(body.height),
		spilled,
		reachable,
		host: shown ? { lines: Math.round(host.getBoundingClientRect().height / parseFloat(getComputedStyle(host).lineHeight)), ellipsis: host.scrollWidth > host.clientWidth ? getComputedStyle(host).textOverflow : null, title: host.title, text: host.textContent } : null,
	};
})()`;

type PopupFit = { innerWidth: number; bodyWidth: number; scrollWidth: number; height: number; spilled: string[]; reachable: boolean; host: { lines: number; ellipsis: string | null; title: string; text: string } | null };

test('lane 8: the popup holds 320 px wide and under the 600 px Chrome allows in every state, and a long host stays on one line with the whole name there for hover and screen readers', async ({ headless }) => {
	test.setTimeout(240_000);
	const seen: Record<string, PopupFit> = {};
	for (const lang of langs) {
		const h = await launch({ headless, lang, account: null });
		try {
			await h.context.route(/example\.com\/|\.example\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title><p>A short paragraph for the host test.</p>' }));
			for (const [name, host] of Object.entries(hosts)) {
				await h.page.goto(`https://${host}/`);
				for (const [state, account] of Object.entries(popupStates)) {
					for (const shortcuts of [undefined, longest]) {
						await worker(h).evaluate(
							async ({ account, shortcuts }) => {
								await chrome.storage.local.set({ account });
								if (shortcuts) await chrome.storage.local.set({ shortcuts });
								else await chrome.storage.local.remove('shortcuts');
							},
							{ account, shortcuts },
						);
						const popup = await h.openPopup();
						await popup.evaluate(`document.getElementById('site-error').hidden = false`);
						await popup.evaluate('new Promise((resolve) => setTimeout(resolve, 80))');
						seen[`${lang} ${name} ${state}${shortcuts ? ', longest shortcuts' : ''}`] = await popup.evaluate<PopupFit>(popupFit);
						if (state.startsWith('pro trial') && name === '253 characters') await popup.screenshot(await fresh(`p5h-popup-tallest-${lang}${shortcuts ? '-long' : ''}`));
						await popup.close();
					}
				}
			}
		} finally {
			h.blockedRequests.length = 0;
			await h.close();
		}
	}
	const tallest = Object.entries(seen).sort(([, a], [, b]) => b.height - a.height).slice(0, 3).map(([where, { height }]) => `${where}: ${height}`);
	console.log(`tallest popups: ${tallest.join('; ')}`);
	console.log(JSON.stringify(Object.fromEntries(Object.entries(seen).filter(([where]) => where.includes('253') && where.includes('pro trial'))), null, 1));
	for (const [where, fit] of Object.entries(seen)) {
		expect(fit.height, where).toBeLessThanOrEqual(600);
		expect({ innerWidth: fit.innerWidth, bodyWidth: fit.bodyWidth, scrollWidth: fit.scrollWidth, spilled: fit.spilled, reachable: fit.reachable }, where).toEqual({ innerWidth: 320, bodyWidth: 320, scrollWidth: 320, spilled: [], reachable: true });
		if (fit.host) expect(fit.host.lines, where).toBe(1);
	}
	const long = seen['en 253 characters pro trial ending, low']?.host;
	expect(long).toEqual({ lines: 1, ellipsis: 'ellipsis', title: hosts['253 characters'], text: hosts['253 characters'] });
});

const lowContrast = (pairs: Pair[]) => pairs.filter((pair) => pair.ratio < (pair.size >= 24 ? 3 : 4.5));

test('lane 9: signed out, settings say only what is true: one line and the sign-in button, no provider, no site list, a translate reason that links to the button, and a language choice that still works', async ({ h }) => {
	test.setTimeout(120_000);
	await seedProviders(h, { chosen: 'opengateway', opengateway: { apiKey: 'sk-test-saved' } });
	await worker(h).evaluate(() => chrome.storage.local.set({ account: { kind: 'signedOut' } }));
	const settings = await openSettings(h);
	const seen: Record<string, unknown> = {};
	for (const lang of langs) {
		await settings.evaluate((lang) => (document.querySelector(`input[name="language"][value="${lang}"]`) as HTMLInputElement).click(), lang);
		await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe(lang);
		seen[lang] = await settings.evaluate(() => ({
			intro: document.getElementById('intro')?.textContent,
			signIn: document.getElementById('sign-in')?.textContent?.trim(),
			provider: document.getElementById('provider-section')?.checkVisibility(),
			sites: document.getElementById('sites-section')?.checkVisibility(),
			reason: document.querySelector('#auto-translate-reason a')?.textContent,
			hint: document.getElementById('auto-translate-hint')?.checkVisibility(),
			text: document.body.innerText,
		}));
		for (const scheme of ['light', 'dark'] as const) {
			await settings.emulateMedia({ colorScheme: scheme });
			await settings.screenshot({ path: await fresh(`p5h-settings-signedout-${lang}-${scheme}`), fullPage: true, animations: 'disabled' });
			expect(lowContrast(await settings.evaluate<Pair[]>(contrastProbe)), `${lang} ${scheme}`).toEqual([]);
		}
	}
	await settings.emulateMedia({ colorScheme: 'light' });
	const untrue = /key works|come from|comes from|on for every site|quick summaries|잘 작동|에서 AI 요약을 받|모든 사이트|빠른 요약|API key|API 키/;
	console.log(JSON.stringify(seen, null, 1).replaceAll('sk-test-saved', '<key>'));
	expect(seen.en).toMatchObject({ intro: 'tfold shortens the paragraph you are reading, right where it is. Sign in with Google to use it on any web page.', signIn: 'Continue with Google', provider: false, sites: false, reason: 'Sign in to use this.', hint: false });
	expect(seen.ko).toMatchObject({ intro: '읽던 문단을 그 자리에서 짧게 접어 줘요. Google로 로그인하면 어떤 웹 페이지에서든 쓸 수 있어요.', signIn: 'Google로 계속하기', provider: false, sites: false, reason: '로그인하면 쓸 수 있어요.', hint: false });
	for (const lang of langs) expect((seen[lang] as { text: string }).text, lang).not.toMatch(untrue);

	await settings.locator('#auto-translate-reason a').click();
	await expect(settings.locator('#sign-in')).toBeFocused();
	await h.context.route(signInUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<title>tfold sign-in</title>' }));
	await settings.locator('#sign-in').click();
	await expect.poll(() => h.tabUrls()).toContain(signInUrl);

	await settings.evaluate(() => (document.querySelector('input[name="language"][value="en"]') as HTMLInputElement).click());
	await expect.poll(() => worker(h).evaluate(async () => (await chrome.storage.sync.get('readerLanguage')).readerLanguage)).toBe('en');
	await settings.close();
	expect(errors(h)).toEqual([]);
});

test('lane 10: with no key the order is get a key, paste, save: the lime button comes first, an account is mentioned once, the cost is body text with no figure, save does not jump, and the sections keep one order', async ({ h }) => {
	test.setTimeout(120_000);
	const stub = await stubKeyChecks(h);
	const seen: Record<string, unknown> = {};
	const lime = 'rgb(201, 251, 44)';
	const order = (settings: Page) => settings.evaluate(() => [...document.querySelectorAll('h2')].filter((h2) => h2.checkVisibility()).map((h2) => h2.id.replace('-heading', '')));
	const saveTop = (settings: Page) => settings.locator('#save').evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
	const fillOf = (settings: Page, selector: string) => settings.locator(selector).evaluate((el) => getComputedStyle(el).backgroundColor);
	const view = (settings: Page) =>
		settings.evaluate(() => {
			const top = (id: string) => document.getElementById(id)?.getBoundingClientRect().top ?? -1;
			const shown = (id: string) => document.getElementById(id)?.checkVisibility() === true;
			const text = (id: string) => document.getElementById(id)?.textContent;
			const link = document.getElementById('get-key') as HTMLAnchorElement;
			return {
				get: shown('get-key') ? { text: link.textContent, href: link.href, target: link.target, height: link.getBoundingClientRect().height, fill: getComputedStyle(link).backgroundColor } : null,
				state: text('key-state'),
				remove: shown('remove-key'),
				money: text('key-money'),
				moneySize: getComputedStyle(document.getElementById('key-money') as HTMLElement).fontSize,
				label: text('key-label'),
				save: text('save'),
				inOrder: shown('get-key') ? top('get-key') < top('key') && top('key') < top('save') : top('key') < top('save'),
				radios: document.querySelectorAll('input[name="provider"]').length,
				section: document.getElementById('provider-section')?.innerText,
			};
		});
	for (const lang of langs) {
		await worker(h).evaluate((readerLanguage) => chrome.storage.sync.set({ readerLanguage }), lang);
		await seedProviders(h, undefined);
		const settings = await openSettings(h);
		await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe(lang);
		seen[`${lang} no key`] = await view(settings);
		seen[`${lang} order`] = await order(settings);
		const saveBefore = await saveTop(settings);
		for (const scheme of ['light', 'dark'] as const) {
			await settings.emulateMedia({ colorScheme: scheme });
			await settings.locator('#provider-section').screenshot({ path: await fresh(`p5h-first-run-${lang}-${scheme}`), animations: 'disabled' });
			expect(lowContrast(await settings.evaluate<Pair[]>(contrastProbe)), `${lang} ${scheme}`).toEqual([]);
		}
		await settings.emulateMedia({ colorScheme: 'light' });
		await expect(settings.locator('#save'), 'a disabled save is not solid').toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		const before = await settings.locator('#keyboard').evaluate((el) => Math.round(el.getBoundingClientRect().top));
		await settings.locator('#key').pressSequentially('sk-typing', { delay: 2 });
		expect(await settings.locator('#keyboard').evaluate((el) => Math.round(el.getBoundingClientRect().top)), 'typing moves nothing').toBe(before);
		await expect(settings.locator('#save'), 'lime moves to the next step').toHaveCSS('background-color', lime);
		expect(await fillOf(settings, '#get-key')).not.toBe(lime);
		await settings.locator('#save').click();
		await saveTone(settings, 'success');
		seen[`${lang} keyed`] = await view(settings);
		seen[`${lang} order keyed`] = await order(settings);
		seen[`${lang} save moved`] = (await saveTop(settings)) - saveBefore;
		await settings.reload();
		await expect(settings.locator('#route')).not.toBeEmpty();
		seen[`${lang} order reloaded`] = await order(settings);
		await settings.close();
	}
	console.log(JSON.stringify(seen, null, 1));
	const fixed = ['sample', 'provider', 'keyboard', 'language', 'sites', 'privacy'];
	const shape = { inOrder: true, radios: 0, moneySize: '14px' };
	expect(seen['en no key']).toMatchObject({
		...shape,
		get: { text: 'Get an OpenGateway key', href: 'https://opengateway.ai/api-keys', target: '_blank', height: 36, fill: lime },
		state: 'You need an OpenGateway account.',
		remove: false,
		money: 'You pay OpenGateway for what you use, from your own account.',
		label: 'OpenGateway API key',
		save: 'Save key',
	});
	expect(seen['ko no key']).toMatchObject({
		...shape,
		get: { text: 'OpenGateway에서 키 받기', href: 'https://opengateway.ai/api-keys', target: '_blank', height: 36, fill: lime },
		state: 'OpenGateway 계정이 있어야 해요.',
		remove: false,
		money: '쓴 만큼 내 OpenGateway 계정에서 비용이 나가요.',
		label: 'OpenGateway API 키',
		save: '키 저장',
	});
	expect(seen['en keyed']).toMatchObject({ ...shape, get: null, remove: true, state: 'A key is saved. Type a new one to replace it.', money: 'You pay OpenGateway for what you use, from your own account.' });
	expect(seen['ko keyed']).toMatchObject({ ...shape, get: null, remove: true, state: '키가 저장돼 있어요. 바꾸려면 새 키를 넣으세요.', money: '쓴 만큼 내 OpenGateway 계정에서 비용이 나가요.' });
	for (const lang of langs) {
		for (const when of ['order', 'order keyed', 'order reloaded']) expect(seen[`${lang} ${when}`], `${lang} ${when}`).toEqual(fixed);
		expect(seen[`${lang} save moved`], `${lang} save stays where the pointer left it`).toBe(0);
		const { section } = seen[`${lang} no key`] as { section: string };
		expect(section.match(/You need|있어야/g), `${lang} the account is mentioned once`).toHaveLength(1);
		expect(section, `${lang} no sentence about being signed out, and no price`).not.toMatch(/signed out|로그인 전|\$|₩|\d+\s*원|\d[\d.,]*\s*(?:usd|dollars?|달러)/i);
	}
	expect(stub.seen).toEqual(['opengateway', 'opengateway']);
	expect(errors(h)).toEqual([]);
});

test('lane 11: OpenGateway comes first and OpenRouter waits in Advanced, a reader with only an OpenRouter key stays there, Use instead never stops summaries that work, a typed key stays with its service, and only the route sentence names the service in use', async ({ headless }) => {
	test.setTimeout(240_000);
	const seen: Record<string, unknown> = {};
	for (const lang of langs) {
		const h = await launch({ headless, lang });
		try {
			const stub = await stubKeyChecks(h);
			const table = lang === 'en' ? en : ko;
			const stored = () => worker(h).evaluate(async () => ((await chrome.storage.local.get('providers')).providers as { chosen?: string } | undefined)?.chosen ?? null);
			const view = (settings: Page) =>
				settings.evaluate(() => {
					const text = (id: string) => document.getElementById(id)?.textContent;
					const link = document.getElementById('get-key') as HTMLAnchorElement;
					return {
						route: text('route'),
						label: text('key-label'),
						backupLabel: text('backup-key-label'),
						use: text('use-other'),
						status: text('status'),
						advanced: (document.getElementById('advanced') as HTMLDetailsElement).open,
						getKey: link.checkVisibility() ? link.href : null,
						typed: [(document.getElementById('key') as HTMLInputElement).value, (document.getElementById('backup-key') as HTMLInputElement).value],
					};
				});
			const OG = 'OpenGateway';
			const OR = 'OpenRouter';

			await seedProviders(h, undefined);
			const none = await openSettings(h);
			seen[`${lang} no key`] = await view(none);
			expect(await none.locator('#backup-key').isVisible(), `${lang} the other service waits in Advanced`).toBe(false);
			await none.locator('#advanced > summary').click();
			await none.locator('#use-other').click();
			await expect(none.locator('#key-label')).toHaveText(table.keyLabel(OR));
			seen[`${lang} no key, use OpenRouter`] = { ...(await view(none)), chosen: await stored() };
			await none.close();

			await seedProviders(h, { openrouter: { apiKey: 'sk-or' } });
			const onlyOpenRouter = await openSettings(h);
			seen[`${lang} only an OpenRouter key`] = { ...(await view(onlyOpenRouter)), chosen: await stored() };
			await onlyOpenRouter.locator('#provider-section').screenshot({ path: await fresh(`p5h-only-openrouter-${lang}`), animations: 'disabled' });
			await onlyOpenRouter.locator('#remove-key').click();
			await expect(onlyOpenRouter.locator('#undo')).toBeVisible();
			seen[`${lang} removed the only OpenRouter key`] = { ...(await view(onlyOpenRouter)), chosen: await stored() };
			await onlyOpenRouter.locator('#undo').click();
			await expect(onlyOpenRouter.locator('#remove-key')).toBeVisible();
			await seedProviders(h, { openrouter: { apiKey: 'sk-or' } });
			await onlyOpenRouter.reload();
			await expect(onlyOpenRouter.locator('#route')).not.toBeEmpty();
			await onlyOpenRouter.locator('#advanced > summary').click();
			await onlyOpenRouter.locator('#backup-key').fill('sk-og');
			await onlyOpenRouter.locator('#save').click();
			await saveTone(onlyOpenRouter, 'success');
			seen[`${lang} OpenRouter first, OpenGateway saved as backup`] = { ...(await view(onlyOpenRouter)), chosen: await stored() };
			await onlyOpenRouter.close();

			await seedProviders(h, { opengateway: { apiKey: 'sk-og' } });
			const keyed = await openSettings(h);
			await keyed.locator('#advanced > summary').click();
			await keyed.locator('#use-other').click();
			await expect(keyed.locator('#status')).not.toBeEmpty();
			await expect(keyed.locator('#backup-key')).toBeFocused();
			seen[`${lang} use OpenRouter with no key for it`] = { ...(await view(keyed)), chosen: await stored() };
			await keyed.locator('#backup-key').fill('sk-or');
			await keyed.locator('#save').click();
			await saveTone(keyed, 'success');
			seen[`${lang} OpenRouter saved as backup`] = { ...(await view(keyed)), chosen: await stored() };
			await keyed.locator('#use-other').click();
			await expect(keyed.locator('#key-label')).toHaveText(table.keyLabel(OR));
			seen[`${lang} use OpenRouter`] = { ...(await view(keyed)), chosen: await stored() };
			await keyed.locator('#use-other').focus();
			await keyed.keyboard.press('Enter');
			await expect(keyed.locator('#key-label')).toHaveText(table.keyLabel(OG));
			seen[`${lang} back by keyboard`] = { ...(await view(keyed)), chosen: await stored() };

			stub.seen.length = 0;
			await keyed.locator('#key').fill('sk-typed-og');
			await keyed.locator('#use-other').click();
			await expect(keyed.locator('#key-label')).toHaveText(table.keyLabel(OR));
			seen[`${lang} typed, then use OpenRouter`] = await view(keyed);
			await keyed.locator('#save').click();
			await saveTone(keyed, 'success');
			expect(await storedKey(h, 'opengateway'), `${lang} the typed key stays with its service`).toBe('sk-typed-og');
			expect(stub.seen, lang).toEqual(['opengateway']);
			const page = await keyed.locator('#provider-section').innerText();
			const sentence = await keyed.locator('#route').textContent();
			expect(page.split(sentence ?? '').length - 1, `${lang} one route sentence`).toBe(1);
			expect(page, `${lang} nothing else says which service answers`).not.toMatch(lang === 'en' ? /now come from|keep coming/ : /이제 .*AI 요약을 받|계속 .*AI 요약을 받/);
			await keyed.close();
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	}
	console.log(JSON.stringify(seen, null, 1));
	const shape = (table: typeof en) => ({
		noKey: { route: table.routeNoKey, label: table.keyLabel('OpenGateway'), advanced: false, getKey: 'https://opengateway.ai/api-keys' },
		useOpenRouter: { route: table.routeNoKey, label: table.keyLabel('OpenRouter'), getKey: 'https://openrouter.ai/settings/keys', chosen: 'openrouter' },
		only: { route: table.routeOne('OpenRouter'), label: table.keyLabel('OpenRouter'), getKey: null, chosen: null, advanced: false },
		removed: { route: table.routeNoKey, label: table.keyLabel('OpenRouter'), chosen: 'openrouter' },
		orFirst: { route: table.routeBoth('OpenRouter', 'OpenGateway'), label: table.keyLabel('OpenRouter'), backupLabel: table.backupKeyLabel('OpenGateway'), chosen: 'openrouter' },
		noKeyForIt: { route: table.routeOne('OpenGateway'), label: table.keyLabel('OpenGateway'), status: table.useNeedsKey('OpenRouter'), chosen: null },
		backup: { route: table.routeBoth('OpenGateway', 'OpenRouter'), label: table.keyLabel('OpenGateway'), backupLabel: table.backupKeyLabel('OpenRouter'), use: table.useInstead('OpenRouter'), chosen: null },
		switched: { route: table.routeBoth('OpenRouter', 'OpenGateway'), label: table.keyLabel('OpenRouter'), backupLabel: table.backupKeyLabel('OpenGateway'), use: table.useInstead('OpenGateway'), status: '', chosen: 'openrouter' },
		back: { route: table.routeBoth('OpenGateway', 'OpenRouter'), label: table.keyLabel('OpenGateway'), chosen: 'opengateway' },
		typed: { typed: ['', 'sk-typed-og'] },
	});
	for (const [lang, table] of [['en', en], ['ko', ko]] as const) {
		const want = shape(table);
		expect(seen[`${lang} no key`]).toMatchObject(want.noKey);
		expect(seen[`${lang} no key, use OpenRouter`]).toMatchObject(want.useOpenRouter);
		expect(seen[`${lang} only an OpenRouter key`]).toMatchObject(want.only);
		expect(seen[`${lang} removed the only OpenRouter key`]).toMatchObject(want.removed);
		expect(seen[`${lang} OpenRouter first, OpenGateway saved as backup`]).toMatchObject(want.orFirst);
		expect(seen[`${lang} use OpenRouter with no key for it`]).toMatchObject(want.noKeyForIt);
		expect(seen[`${lang} OpenRouter saved as backup`]).toMatchObject(want.backup);
		expect(seen[`${lang} use OpenRouter`]).toMatchObject(want.switched);
		expect(seen[`${lang} back by keyboard`]).toMatchObject(want.back);
		expect(seen[`${lang} typed, then use OpenRouter`]).toMatchObject(want.typed);
	}
});

const sampleText = (settings: Page) =>
	settings.evaluate(() => {
		const stage = document.getElementById('sample-stage') as HTMLElement;
		const overlay = stage.querySelector('[data-tfold-overlay]');
		const shown = overlay ?? document.getElementById('sample-text');
		return {
			text: shown?.textContent,
			level: overlay?.getAttribute('data-tf-level') ?? '0',
			source: overlay?.getAttribute('data-tf-fold') ?? null,
			label: document.getElementById('sample-level')?.textContent,
			overlays: document.querySelectorAll('[data-tfold-overlay]').length,
		};
	});

const sampleCenter = (settings: Page) => settings.locator('#sample-stage').evaluate((el) => {
	el.scrollIntoView({ block: 'center' });
	const box = el.getBoundingClientRect();
	return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
});

async function sampleSession(settings: Page) {
	const cdp = await settings.context().newCDPSession(settings);
	return {
		wheel: async (steps: number) => {
			const point = await sampleCenter(settings);
			await settings.mouse.move(point.x, point.y);
			await foldAt(cdp, point.x, point.y, steps);
			await settings.waitForTimeout(450);
		},
	};
}

const levelsOf = (table: typeof en) => {
	const { sentences, brief, key, takeaway } = table.sampleFold;
	return [sentences.join(' '), brief.map((index) => sentences[index]).join(' '), key, takeaway];
};

const labelOf = (table: typeof en, level: 0 | 1 | 2 | 3) => `${table.sampleLevels[level].name} ${table.sampleLevels[level].about}`;

const quickLevelsOf = (table: typeof en) => {
	const full = table.sampleFold.sentences.join(' ');
	const { sentences, key, takeaway } = localFold(full);
	return [full, sentences[0], key, takeaway];
};

const quickLabelOf = (table: typeof en, level: 0 | 1 | 2 | 3) => `${table.sampleQuickLevels[level].name} ${table.sampleQuickLevels[level].about}`;

test('lane 12: the sample paragraph folds through every level and back with the real fold, scroll and shortcut code, in every account state and both languages, with no model call and no network', async ({ headless }) => {
	test.setTimeout(300_000);
	const accounts: Record<string, Account> = { 'signed out': { kind: 'signedOut' }, free: { kind: 'free' }, pro: { kind: 'pro', remainingPercent: 72, resetsAt: inDays(20) } };
	const seen: Record<string, unknown> = {};
	for (const [lang, table] of [['en', en], ['ko', ko]] as const) {
		const h = await launch({ headless, lang, account: null });
		try {
			const stub = await stubKeyChecks(h);
			await seedProviders(h, { chosen: 'opengateway', opengateway: { apiKey: 'sk-test-saved' } });
			for (const [name, account] of Object.entries(accounts)) {
				const texts = name === 'signed out' ? quickLevelsOf(table) : levelsOf(table);
				const labels = (level: 0 | 1 | 2 | 3) => (name === 'signed out' ? quickLabelOf : labelOf)(table, level);
				await worker(h).evaluate((account) => chrome.storage.local.set({ account }), account);
				const settings = await openSettings(h, 860, 900);
				if (name !== 'free') await expect(settings.locator('#provider-section')).toBeHidden();
				await expect(settings.locator('#sample-level')).toHaveText(labels(0));
				const session = await sampleSession(settings);
				const below = () => settings.locator('#keyboard').evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
				const stageStart = await below();
				const path: unknown[] = [];
				for (const level of [1, 2, 3] as const) {
					await session.wheel(1);
					const state = await sampleText(settings);
					path.push(state.level);
					expect(state, `${lang} ${name} fold to ${level}`).toEqual({ text: texts[level], level: String(level), source: 'model', label: labels(level), overlays: 1 });
					expect(await below(), 'the page below stays put').toBe(stageStart);
				}
				await session.wheel(1);
				expect((await sampleText(settings)).level, 'level 3 is the end').toBe('3');
				const under = await settings.evaluate(() => {
					const box = (document.getElementById('sample-stage') as HTMLElement).getBoundingClientRect();
					return document.elementFromPoint(box.left + box.width / 2, box.bottom - 4)?.hasAttribute('data-tfold-overlay') ?? false;
				});
				expect(under, 'the pointer is still on the paragraph at the deepest level').toBe(true);
				for (const level of [2, 1, 0] as const) {
					await session.wheel(-1);
					const state = await sampleText(settings);
					path.push(state.level);
					expect(state, `${lang} ${name} spread to ${level}`).toMatchObject({ text: texts[level], level: String(level), label: labels(level), overlays: level === 0 ? 0 : 1 });
				}
				await settings.keyboard.press('Alt+Shift+ArrowDown');
				expect(await sampleText(settings), `${lang} ${name} shortcut down`).toMatchObject({ level: '1', label: labels(1) });
				await settings.keyboard.press('Alt+Shift+ArrowUp');
				expect(await sampleText(settings), `${lang} ${name} shortcut up`).toMatchObject({ level: '0', label: labels(0) });
				seen[`${lang} ${name}`] = path;
				await settings.close();
			}
			expect(h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('fold'))).toEqual([]);
			expect(stub.seen).toEqual([]);
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	}
	console.log(JSON.stringify(seen));
});

test('lane 13: the sample morphs with the real word animation, stops animating for reduced motion, follows a changed shortcut and the language, works from the keyboard alone, and folds nothing else on the page', async ({ h }) => {
	test.setTimeout(120_000);
	await worker(h).evaluate(() => chrome.storage.sync.set({ readerLanguage: 'en' }));
	const settings = await openSettings(h);
	const session = await sampleSession(settings);
	await session.wheel(0);

	const started = settings.evaluate(() => new Promise<{ ghosts: boolean; animations: number }>((resolve) => {
		new MutationObserver((_, observer) => {
			if (document.querySelector('tfold-ghosts') === null) return;
			observer.disconnect();
			resolve({ ghosts: true, animations: document.getAnimations().length });
		}).observe(document.documentElement, { childList: true });
	}));
	await settings.keyboard.press('Alt+Shift+ArrowDown');
	const moved = await started;
	expect(moved.ghosts, 'the real morph layer appears').toBe(true);
	await settings.waitForTimeout(450);
	await settings.keyboard.press('Alt+Shift+ArrowUp');
	await settings.waitForTimeout(450);

	await settings.emulateMedia({ reducedMotion: 'reduce' });
	await settings.keyboard.press('Alt+Shift+ArrowDown');
	const reduced = await settings.evaluate(() => ({ ghosts: document.querySelector('tfold-ghosts') !== null, level: document.querySelector('#sample-stage [data-tfold-overlay]')?.getAttribute('data-tf-level') }));
	expect(reduced).toEqual({ ghosts: false, level: '1' });
	await settings.keyboard.press('Alt+Shift+ArrowUp');
	await settings.emulateMedia({ reducedMotion: 'no-preference' });

	await settings.locator('[data-change="fold"]').click();
	await settings.keyboard.press('Alt+Shift+KeyJ');
	expect((await sampleText(settings)).level, 'pressing keys while recording does not fold').toBe('0');
	await expect(settings.locator('#keys-status')).toHaveText('Fold is now Alt+Shift+J.');
	await expect(settings.locator('#shortcuts .fold-keys')).toHaveText('Alt+Shift+J');
	await session.wheel(0);
	await settings.keyboard.press('Alt+Shift+KeyJ');
	expect((await sampleText(settings)).level, 'the new shortcut folds the sample').toBe('1');
	await settings.keyboard.press('Alt+Shift+ArrowUp');
	await settings.locator('#default-keys').click();
	await expect(settings.locator('#keys-status')).toHaveText('The default shortcuts are back.');

	await settings.mouse.move(2, 2);
	await settings.evaluate(() => (document.getElementById('sample-stage') as HTMLElement).focus());
	await settings.waitForTimeout(50);
	await settings.mouse.move(3, 3);
	await settings.keyboard.press('Alt+Shift+ArrowDown');
	expect((await sampleText(settings)).level, 'keyboard focus is enough').toBe('1');
	await settings.keyboard.press('Alt+Shift+ArrowDown');
	expect((await sampleText(settings)).level).toBe('2');
	await settings.waitForTimeout(450);

	await worker(h).evaluate(() => chrome.storage.sync.set({ readerLanguage: 'ko' }));
	await expect(settings.locator('#sample-level')).toHaveText(quickLabelOf(ko, 0));
	expect(await sampleText(settings)).toMatchObject({ text: quickLevelsOf(ko)[0], level: '0', overlays: 0 });
	await settings.keyboard.press('Alt+Shift+ArrowDown');
	expect(await sampleText(settings), 'the sample folds in the new language').toMatchObject({ text: quickLevelsOf(ko)[1], level: '1', label: quickLabelOf(ko, 1) });
	await settings.keyboard.press('Alt+Shift+ArrowUp');

	const cdp = await h.context.newCDPSession(settings);
	await settings.evaluate(() => (document.activeElement as HTMLElement).blur());
	const intro = await settings.locator('#intro').evaluate((el) => {
		el.scrollIntoView({ block: 'center' });
		const box = el.getBoundingClientRect();
		return { x: box.left + 40, y: box.top + 8 };
	});
	await settings.mouse.move(intro.x, intro.y);
	await foldAt(cdp, intro.x, intro.y, 1);
	await settings.waitForTimeout(100);
	expect(await settings.evaluate(() => document.querySelectorAll('[data-tfold-overlay]').length), 'a fold on the rest of the page folds nothing').toBe(0);
	await settings.keyboard.press('Alt+Shift+ArrowDown');
	await settings.waitForTimeout(100);
	expect(await settings.evaluate(() => [...document.querySelectorAll('[data-tfold-overlay]')].every((overlay) => document.getElementById('sample-stage')?.contains(overlay))), 'nothing else on the page folds').toBe(true);
	await settings.close();
	expect(h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('fold'))).toEqual([]);
	expect(errors(h)).toEqual([]);
});

test('lane 14: every level of the sample in both languages and both themes, at full width and at 320 px, stays readable and inside the page', async ({ h }) => {
	test.setTimeout(180_000);
	const settings = await openSettings(h, 860, 900);
	const session = await sampleSession(settings);
	for (const lang of langs) {
		await worker(h).evaluate((readerLanguage) => chrome.storage.sync.set({ readerLanguage }), lang);
		await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe(lang);
		await session.wheel(0);
		for (const level of [0, 1, 2, 3] as const) {
			for (const scheme of ['light', 'dark'] as const) {
				await settings.emulateMedia({ colorScheme: scheme });
				await settings.locator('#sample-section').screenshot({ path: await fresh(`p5h-sample-${lang}-${level}-${scheme}`), animations: 'disabled' });
				expect(lowContrast(await settings.evaluate<Pair[]>(contrastProbe)), `${lang} ${level} ${scheme}`).toEqual([]);
			}
			await settings.emulateMedia({ colorScheme: 'light' });
			await settings.setViewportSize({ width: 320, height: 720 });
			await settings.waitForTimeout(80);
			expect(await settings.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${lang} ${level} at 320 px`).toBe(0);
			if (level === 3) await settings.locator('#sample-section').screenshot({ path: await fresh(`p5h-sample-${lang}-320`), animations: 'disabled' });
			await settings.setViewportSize({ width: 860, height: 900 });
			if (level < 3) await session.wheel(1);
		}
		await session.wheel(-3);
		await settings.screenshot({ path: await fresh(`p5h-settings-free-${lang}`), fullPage: true, animations: 'disabled' });
	}
	await settings.close();
	expect(errors(h)).toEqual([]);
});

test('lane 15: the first working key points at the sample and moves focus there, a later key does not, and a refused key does not', async ({ h }) => {
	const stub = await stubKeyChecks(h);
	const seen: Record<string, unknown> = {};
	for (const lang of langs) {
		await worker(h).evaluate((readerLanguage) => chrome.storage.sync.set({ readerLanguage }), lang);
		await seedProviders(h, undefined);
		const settings = await openSettings(h);
		await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe(lang);
		stub.answer.opengateway = refused;
		await settings.locator('#key').fill('sk-bad');
		await settings.locator('#save').click();
		await saveTone(settings, 'error');
		const afterRefusal = await settings.locator('#try-sample').isVisible();
		stub.answer.opengateway = works.opengateway;
		await settings.locator('#key').fill('sk-good');
		await settings.locator('#save').click();
		await saveTone(settings, 'success');
		await expect(settings.locator('#try-sample')).toBeFocused();
		seen[lang] = await settings.locator('#try-sample').textContent();
		for (const scheme of ['light', 'dark'] as const) {
			await settings.emulateMedia({ colorScheme: scheme });
			await settings.locator('#provider-section').screenshot({ path: await fresh(`p5h-first-key-${lang}-${scheme}`), animations: 'disabled' });
		}
		await settings.emulateMedia({ colorScheme: 'light' });
		await settings.locator('#try-sample').click();
		await expect(settings.locator('#sample-stage')).toBeFocused();
		await settings.keyboard.press('Alt+Shift+ArrowDown');
		expect((await sampleText(settings)).level, 'the keys work right there').toBe('1');
		await settings.keyboard.press('Alt+Shift+ArrowUp');
		await settings.locator('#key').fill('sk-second');
		await settings.locator('#save').click();
		await saveTone(settings, 'success');
		expect(await settings.locator('#try-sample').isVisible(), 'a second key does not point there again').toBe(false);
		expect(afterRefusal).toBe(false);
		await settings.close();
	}
	expect(seen).toEqual({ en: 'Now fold the paragraph above', ko: '이제 위 문단을 접어 보세요' });
	expect(errors(h)).toEqual([]);
});

test('lane 16: popup, settings and the page hint name both directions and hold Ctrl for both ways of scrolling, with one key notation per platform and spoken names for keys and the meter', async ({ headless }) => {
	test.setTimeout(180_000);
	const seen: Record<string, unknown> = {};
	const readPopup = `(() => {
		const key = (id) => { const el = document.getElementById(id); return { text: el.textContent, role: el.getAttribute('role'), spoken: el.getAttribute('aria-label') }; };
		const row = document.getElementById('add-key').getBoundingClientRect();
		const text = document.getElementById('provider-state').getBoundingClientRect();
		return {
			how: document.querySelector('#how-title').textContent,
			fold: key('fold-keys'),
			unfold: key('unfold-keys'),
			scroll: key('scroll-keys'),
			addKeyBelow: row.top >= text.bottom,
			addKeyWidth: Math.round(row.width),
			rowWidth: Math.round(document.getElementById('provider-row').getBoundingClientRect().width),
			meter: document.getElementById('meter').getAttribute('aria-valuetext'),
		};
	})()`;
	for (const lang of langs) {
		const h = await launch({ headless, lang });
		try {
			await worker(h).evaluate(() => chrome.storage.local.set({ hintSeen: false }));
			await h.navigate(fixtures.wiki);
			const paragraph = '#mw-content-text section > p:not(.mw-empty-elt) >> nth=1';
			await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
			const { x, y } = await h.pointAt(paragraph);
			await h.page.mouse.move(x, y);
			await expect.poll(() => h.page.locator('tf-hint').count(), { timeout: 5_000 }).toBe(1);
			const hint = await h.page.locator('tf-hint').evaluate((el) => el.shadowRoot?.querySelector('div')?.textContent);
			await worker(h).evaluate((account) => chrome.storage.local.set({ account }), { kind: 'pro', remainingPercent: 72, resetsAt: inDays(20) });
			const popup = await h.openPopup();
			const pro = await popup.evaluate(readPopup);
			await popup.close();
			await worker(h).evaluate(() => chrome.storage.local.set({ account: { kind: 'free' }, hasFolded: true }));
			const free = await h.openPopup();
			const inFree = await free.evaluate(readPopup);
			for (const scheme of ['light', 'dark'] as const) {
				await free.colorScheme(scheme);
				await free.screenshot(await fresh(`p5h-popup-free-${lang}-${scheme}`));
			}
			await free.close();
			const settings = await openSettings(h);
			const inSettings = await settings.evaluate(() => {
				const key = document.querySelector('#shortcuts .fold-keys') as HTMLElement;
				return {
					intro: document.getElementById('intro')?.textContent,
					hint: document.getElementById('keyboard-hint')?.textContent,
					scroll: document.querySelector('input[name="scroll-modifier"]:checked')?.parentElement?.textContent,
					spoken: key.getAttribute('aria-label'),
					role: key.getAttribute('role'),
					rows: document.querySelectorAll('#shortcuts .row').length,
				};
			});
			await settings.close();
			seen[lang] = { hint, pro, inFree, inSettings };
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
		const mac = await launch({ headless, lang });
		try {
			await mac.context.addInitScript(`Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })`);
			const page = await mac.context.newPage();
			await page.setViewportSize({ width: 320, height: 600 });
			await page.goto(`chrome-extension://${mac.extensionId}/popup/popup.html`);
			await expect(page.locator('#fold-keys')).not.toBeEmpty();
			seen[`${lang} mac`] = await page.evaluate(() => ['fold-keys', 'unfold-keys', 'scroll-keys'].map((id) => document.getElementById(id)?.textContent));
			await page.screenshot({ path: await fresh(`p5h-popup-mac-${lang}`) });
			await page.close();
		} finally {
			await mac.close();
		}
	}
	console.log(JSON.stringify(seen, null, 1));
	expect(seen.en).toMatchObject({
		hint: 'Hold Ctrl and scroll down over a paragraph to shorten it, up to bring it back. Or press Alt+Shift+↓, Alt+Shift+↑',
		pro: { meter: '72% left this month' },
		inFree: {
			how: 'Hold Ctrl and a green line marks the paragraph, then scroll. Or use the shortcut.',
			fold: { text: 'Alt+Shift+↓', role: 'img', spoken: 'Alt Shift down arrow' },
			unfold: { text: 'Alt+Shift+↑', role: 'img', spoken: 'Alt Shift up arrow' },
			scroll: { text: 'Ctrl+scroll ↓ ↑', role: 'img', spoken: 'Ctrl scroll down arrow up arrow' },
			addKeyBelow: true,
		},
		inSettings: {
			intro: en.settingsIntro,
			hint: en.keyboardHint,
			scroll: 'Ctrl',
			spoken: 'Alt Shift down arrow',
			role: 'img',
			rows: 3,
		},
	});
	expect(seen.ko).toMatchObject({
		hint: 'Ctrl 키를 누른 채 문단 위에서 아래로 스크롤하면 접히고, 위로 스크롤하면 펼쳐져요. 단축키는 Alt+Shift+↓, Alt+Shift+↑',
		pro: { meter: '이번 달 남은 사용량 72%' },
		inFree: {
			how: 'Ctrl 누르고 있으면 문단 옆에 초록 선이 나와요. 그대로 스크롤하면 접혀요. 아래 단축키로도 접을 수 있어요.',
			fold: { text: 'Alt+Shift+↓', role: 'img', spoken: 'Alt Shift 아래 화살표' },
			scroll: { text: 'Ctrl+스크롤 ↓ ↑', role: 'img', spoken: 'Ctrl 스크롤 아래 화살표 위 화살표' },
			addKeyBelow: true,
		},
		inSettings: {
			intro: ko.settingsIntro,
			scroll: 'Ctrl',
			rows: 3,
		},
	});
	for (const lang of langs) {
		const row = (seen[lang] as { inFree: { addKeyWidth: number; rowWidth: number } }).inFree;
		expect(row.addKeyWidth, `${lang} the button fills its row`).toBe(row.rowWidth - 36);
	}
	expect(seen['en mac']).toEqual(['Option+Shift+↓', 'Option+Shift+↑', 'Cmd+scroll ↓ ↑']);
	expect(seen['ko mac']).toEqual(['Option+Shift+↓', 'Option+Shift+↑', 'Cmd+스크롤 ↓ ↑']);
});

test('lane 17: an empty or malformed model id is turned down without saving anything, a good one says what was checked, and the switch and selected tile show their state without color', async ({ h }) => {
	const stub = await stubKeyChecks(h);
	const seen: Record<string, unknown> = {};
	for (const lang of langs) {
		await worker(h).evaluate((readerLanguage) => chrome.storage.sync.set({ readerLanguage }), lang);
		await seedProviders(h, { chosen: 'opengateway', opengateway: { apiKey: 'sk-saved' } });
		const settings = await openSettings(h);
		await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe(lang);
		await settings.locator('#advanced > summary').click();
		const defaultModel = await settings.locator('#model').inputValue();
		const storedModel = () => worker(h).evaluate(async () => ((await chrome.storage.local.get('providers')).providers as { opengateway?: { model?: string } } | undefined)?.opengateway?.model ?? null);
		const rows: Record<string, unknown> = {};
		for (const [name, typed] of [['empty', ''], ['spaces', 'not a model'], ['no slash', 'deepseek'], ['ends in a slash', 'deepseek/']] as const) {
			await settings.locator('#model').fill(typed);
			await settings.locator('#save').click();
			await saveTone(settings, 'error');
			rows[name] = { status: await settings.locator('#status').textContent(), invalid: await settings.locator('#model').getAttribute('aria-invalid'), focused: await settings.locator('#model').evaluate((el) => document.activeElement === el), stored: await storedModel() };
		}
		await settings.locator('#model').fill('other/model:free');
		expect(await settings.locator('#model').getAttribute('aria-invalid'), 'typing clears the mark').toBeNull();
		await settings.locator('#save').click();
		await saveTone(settings, 'success');
		rows.good = { status: await settings.locator('#status').textContent(), stored: await storedModel() };
		seen[lang] = rows;
		await settings.locator('#model').fill(defaultModel);
		await settings.locator('#save').click();
		await expect.poll(storedModel).toBeNull();
		await settings.close();
	}
	console.log(JSON.stringify(seen, null, 1));
	const shape = { invalid: 'true', focused: true, stored: null };
	expect(seen.en).toMatchObject({
		empty: { ...shape, status: 'That is not a model id, so tfold saved nothing. A model id looks like deepseek/deepseek-v4.1-flash-ultrafast.' },
		spaces: shape,
		'no slash': shape,
		'ends in a slash': shape,
		good: { status: 'Model saved. tfold only checked how the id looks, so if AI summaries stop, check the id.', stored: 'other/model:free' },
	});
	expect(seen.ko).toMatchObject({
		empty: { ...shape, status: '모델 ID가 아닌 것 같아서 아무것도 저장하지 않았어요. 모델 ID는 deepseek/deepseek-v4.1-flash-ultrafast처럼 생겼어요.' },
		good: { status: '모델을 저장했어요. ID의 형식만 확인했으니, AI 요약이 안 나오면 ID를 다시 확인해 보세요.', stored: 'other/model:free' },
	});
	expect(stub.seen).toEqual([]);

	await worker(h).evaluate(() => chrome.storage.sync.set({ autoTranslate: true, readerLanguage: 'en' }));
	await seedProviders(h, { chosen: 'opengateway', opengateway: { apiKey: 'sk-saved' } });
	const settings = await openSettings(h);
	const state = await settings.evaluate(() => {
		const on = document.getElementById('auto-translate') as HTMLElement;
		const tile = document.querySelector('.choice:has(input[value="en"])') as HTMLElement;
		const other = document.querySelector('.choice:has(input[value="ko"])') as HTMLElement;
		return {
			checked: on.getAttribute('aria-checked'),
			glyph: getComputedStyle(on, '::before').maskImage.includes('svg'),
			selectedEdge: getComputedStyle(tile).boxShadow !== 'none',
			otherEdge: getComputedStyle(other).boxShadow === 'none',
			facts: document.querySelectorAll('#privacy dt').length,
		};
	});
	await settings.locator('#auto-translate').click();
	await expect(settings.locator('#auto-translate')).toHaveAttribute('aria-checked', 'false');
	const glyphOff = await settings.evaluate(() => getComputedStyle(document.getElementById('auto-translate') as HTMLElement, '::before').content);
	expect(state).toEqual({ checked: 'true', glyph: true, selectedEdge: true, otherEdge: true, facts: 4 });
	expect(glyphOff).toBe('none');
	await settings.close();
	expect(errors(h)).toEqual([]);
});

test('lane 18: a key that cannot be a key, such as 9 KB of text, is turned down before any request, in both languages, and stays in the field to fix', async ({ h }) => {
	test.setTimeout(60_000);
	const stub = await stubKeyChecks(h);
	const seen: Record<string, unknown> = {};
	for (const lang of langs) {
		await worker(h).evaluate((readerLanguage) => chrome.storage.sync.set({ readerLanguage }), lang);
		for (const [name, typed] of [
			['9 KB', 'a'.repeat(9 * 1024)],
			['a space', 'two words'],
			['Korean', '한글로 쓴 키'],
		] as const) {
			await seedProviders(h, { chosen: 'opengateway' });
			const settings = await openSettings(h);
			await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe(lang);
			await settings.locator('#key').fill(typed);
			await settings.locator('#save').click();
			await saveTone(settings, 'error');
			seen[`${lang} ${name}`] = await settings.evaluate(() => {
				const input = document.getElementById('key') as HTMLInputElement;
				return { text: document.getElementById('status')?.textContent, invalid: input.getAttribute('aria-invalid'), focused: document.activeElement === input, kept: input.value !== '' };
			});
			expect(await storedKey(h, 'opengateway'), `${lang} ${name}`).toBe('');
			await settings.close();
		}
	}
	console.log(JSON.stringify(seen, null, 1));
	const shape = { invalid: 'true', focused: true, kept: true };
	expect(seen['en 9 KB']).toEqual({ ...shape, text: 'This does not look like an OpenGateway key, so tfold did not send or save it. A key is one unbroken line of letters and numbers. Copy it from OpenGateway again.' });
	expect(seen['ko 9 KB']).toEqual({ ...shape, text: 'OpenGateway 키처럼 보이지 않아서 보내지도, 저장하지도 않았어요. 키는 띄어쓰기 없이 영문과 숫자로 이어진 한 줄이에요. OpenGateway에서 다시 복사해 넣어 보세요.' });
	expect(stub.seen).toEqual([]);
	expect(keyCheckLines(h)).toEqual([]);
	expect(errors(h)).toEqual([]);
});

test('lane 19: a real OpenGateway key reads as works on every save, though the service answers an empty body with a different field from one try to the next', async ({ h }) => {
	test.setTimeout(120_000);
	await stubKeyChecks(h);
	const tones: string[] = [];
	for (let i = 0; i < 12; i++) {
		await seedProviders(h, undefined);
		const settings = await openSettings(h);
		await settings.locator('#key').fill(`sk-test-${i}`);
		await settings.locator('#save').click();
		await expect(settings.locator('#status')).toHaveAttribute('data-tone', /success|caution|error/, { timeout: 12_000 });
		tones.push((await settings.locator('#status').getAttribute('data-tone')) ?? '');
		await settings.close();
	}
	expect(tones).toEqual(Array.from({ length: 12 }, () => 'success'));
	expect(errors(h)).toEqual([]);
});

test('lane 20: while a shortcut is being recorded, a fold, Ctrl and scroll and the current shortcut leave the sample alone, and it folds again once recording ends', async ({ h }) => {
	test.setTimeout(120_000);
	const seen: Record<string, unknown> = {};
	for (const lang of langs) {
		await worker(h).evaluate((readerLanguage) => chrome.storage.sync.set({ readerLanguage }), lang);
		const settings = await openSettings(h);
		await expect.poll(() => settings.evaluate(() => document.documentElement.lang)).toBe(lang);
		const session = await sampleSession(settings);
		await session.wheel(0);
		await settings.locator('[data-change="fold"]').click();
		await session.wheel(2);
		const afterFold = (await sampleText(settings)).level;
		await settings.locator('[data-change="fold"]').click();
		await settings.locator('[data-change="fold"]').click();
		await session.wheel(0);
		await settings.keyboard.press('Alt+Shift+ArrowDown');
		await settings.waitForTimeout(100);
		const afterShortcut = (await sampleText(settings)).level;
		await session.wheel(2);
		const afterRecording = (await sampleText(settings)).level;
		await session.wheel(-2);
		seen[lang] = { afterFold, afterShortcut, afterRecording };
		await settings.close();
	}
	console.log(JSON.stringify(seen));
	for (const lang of langs) expect(seen[lang], lang).toEqual({ afterFold: '0', afterShortcut: '0', afterRecording: '2' });
	expect(errors(h)).toEqual([]);
});

const pageOverlay = (h: Harness) =>
	h.page.evaluate(() => {
		const overlay = document.querySelector('[data-tfold-overlay]');
		return overlay && { fold: overlay.getAttribute('data-tf-fold'), badge: overlay.getAttribute('data-tf-badge'), pending: overlay.hasAttribute('data-tf-pending') };
	});

async function foldOnPage(h: Harness) {
	await h.navigate(fixtures.wiki);
	await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
	const { x, y } = await h.pointAt('#mw-content-text section > p:not(.mw-empty-elt) >> nth=1');
	await h.foldAt(x, y, 2);
	await expect.poll(async () => (await pageOverlay(h))?.pending, { timeout: 15_000 }).toBe(false);
	return pageOverlay(h);
}

test('lane 21: a Pro reader on a page folds with the quick summary and never reads a word about keys, with or without an old key, and Free keeps its badges', async ({ headless }) => {
	test.setTimeout(240_000);
	const pro: Account = { kind: 'pro', remainingPercent: 72, resetsAt: inDays(20) };
	const empty: Account = { kind: 'pro', remainingPercent: 0, resetsAt: inDays(20) };
	const oldKey = { chosen: 'opengateway', opengateway: { apiKey: 'sk-old-og' } };
	const seen: Record<string, unknown> = {};
	for (const lang of langs) {
		const h = await launch({ headless, lang, account: null });
		try {
			const stub = await stubKeyChecks(h);
			stub.answer.opengateway = refused;
			const row = async (name: string, account: Account, providers: object | undefined) => {
				await worker(h).evaluate((account) => chrome.storage.local.set({ account }), account);
				await seedProviders(h, providers);
				stub.seen.length = 0;
				seen[`${lang} ${name}`] = { ...(await foldOnPage(h)), requests: stub.seen.length };
			};
			await row('pro, no key', pro, undefined);
			await row('pro, old key', pro, oldKey);
			await row('pro at 0%, old key', empty, oldKey);
			await row('free, no key', { kind: 'free' }, undefined);
			await row('free, refused key', { kind: 'free' }, oldKey);
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
	}
	console.log(JSON.stringify(seen, null, 1));
	const quiet = { fold: 'local', badge: null, pending: false, requests: 0 };
	for (const lang of langs) {
		for (const name of ['pro, no key', 'pro, old key', 'pro at 0%, old key']) expect(seen[`${lang} ${name}`], `${lang} ${name}`).toEqual(quiet);
	}
	expect(seen['en free, no key']).toMatchObject({ fold: 'local', badge: en.badgeNoKey, requests: 0 });
	expect(seen['ko free, no key']).toMatchObject({ fold: 'local', badge: ko.badgeNoKey, requests: 0 });
	expect(seen['en free, refused key']).toMatchObject({ fold: 'local', badge: en.badgeRefused, requests: 1 });
	expect(seen['ko free, refused key']).toMatchObject({ fold: 'local', badge: ko.badgeRefused, requests: 1 });
});

test('lane 23: settings define the two summaries and say each how-to once, the sample comes first and points onward after the first fold, and every account state reads true in both languages and themes', async ({ headless }) => {
	test.setTimeout(300_000);
	const states: Record<string, Account> = {
		'signed out': { kind: 'signedOut' },
		free: { kind: 'free' },
		pro: { kind: 'pro', remainingPercent: 72, resetsAt: inDays(20) },
		'pro at 0%': { kind: 'pro', remainingPercent: 0, resetsAt: inDays(20) },
	};
	const seen: Record<string, Record<string, unknown>> = {};
	for (const [lang, table] of [['en', en], ['ko', ko]] as const) {
		const h = await launch({ headless, lang, account: null });
		try {
			for (const [name, account] of Object.entries(states)) {
				await worker(h).evaluate((account) => chrome.storage.local.set({ account }), account);
				const settings = await openSettings(h);
				await expect(settings.locator('#default-keys'), `${lang} ${name} a disabled button is not solid`).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
				const before = await settings.evaluate(() => {
					const rect = (id: string) => (document.getElementById(id) as HTMLElement).getBoundingClientRect();
					const hint = document.getElementById('sample-hint') as HTMLElement;
					return {
						intro: document.getElementById('intro')?.textContent,
						sampleHintLines: Math.round(hint.getBoundingClientRect().height / parseFloat(getComputedStyle(hint).lineHeight)),
						next: document.getElementById('sample-next')?.textContent,
						sampleBeforeKey: rect('sample-section').bottom <= rect('provider-section').top,
						keyboardHintBelowTable: rect('keyboard-hint').top >= rect('shortcuts').bottom,
						headings: [...new Set([...document.querySelectorAll('h2')].map((h2) => getComputedStyle(h2).fontWeight))],
						words: document.body.innerText.trim().split(/\s+/).length,
						text: document.body.innerText,
					};
				});
				const session = await sampleSession(settings);
				await session.wheel(1);
				const after = await settings.evaluate(() => ({ next: document.getElementById('sample-next')?.textContent, label: document.getElementById('sample-level')?.textContent }));
				for (const scheme of ['light', 'dark'] as const) {
					await settings.emulateMedia({ colorScheme: scheme });
					await settings.screenshot({ path: await fresh(`p5h-settings-${name.replaceAll(/\W+/g, '-')}-${lang}-${scheme}`), fullPage: true, animations: 'disabled' });
					expect(lowContrast(await settings.evaluate<Pair[]>(contrastProbe)), `${lang} ${name} ${scheme}`).toEqual([]);
				}
				const tile = await settings.evaluate(() => getComputedStyle(document.querySelector('.choice:has(input:checked)') as HTMLElement).backgroundColor);
				await settings.emulateMedia({ colorScheme: 'light' });
				seen[`${lang} ${name}`] = { ...before, after, tile };
				await settings.close();
			}
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
		const row = (name: string) => seen[`${lang} ${name}`] as Record<string, unknown> & { after: { next: string; label: string }; text: string };
		for (const name of Object.keys(states)) {
			expect(row(name), `${lang} ${name}`).toMatchObject({ sampleHintLines: 1, next: '', keyboardHintBelowTable: true, headings: ['600'] });
			expect(row(name).tile, `${lang} ${name} a selected tile in dark is a neutral`).toBe('rgb(74, 74, 80)');
			expect(row(name).after.label).toBe((name.startsWith('pro') ? labelOf : quickLabelOf)(table, 1));
			expect(row(name).text, `${lang} ${name} says no price`).not.toMatch(/\$|₩|\d+\s*원|달러/);
		}
		expect(row('free')).toMatchObject({ intro: table.settingsIntro, sampleBeforeKey: true });
		expect(row('free').after.next).toBe(table.sampleNext);
		expect(row('pro').intro).toBe(storeTables[lang].settingsIntroPro);
		expect(row('pro at 0%').intro, 'a Pro reader at 0% is promised no AI summary').toMatch(lang === 'en' ? /while your Pro plan has usage left/ : /사용량이 남아 있는 동안/);
		expect(row('pro').after.next).toBe(table.sampleNext);
		expect(row('signed out').after.next).toBe(storeTables[lang].sampleNextSignedOut);
		expect(row('signed out').text, 'signed out shows no key field').not.toMatch(/API key|API 키/);
		for (const name of ['signed out', 'pro', 'pro at 0%']) expect(row(name).text, `${lang} ${name} reads no key wording`).not.toMatch(/API|OpenGateway|OpenRouter/);
		for (const fact of table.privacy.flat()) expect(row('free').text, `${lang} the privacy fact stays`).toContain(fact);
	}
	console.log(JSON.stringify(Object.fromEntries(Object.entries(seen).map(([where, row]) => [where, row.words]))));
	expect(ko.sampleLevels[1].name, 'the Korean level label reads naturally').toBe('3단계 중 1단계');
	expect(seen['ko free']?.words, 'still far under the 391 words before').toBeLessThanOrEqual(295);
});

const readPopupState = `(() => {
	const shown = (selector) => document.querySelector(selector)?.checkVisibility() === true;
	const text = (selector) => (shown(selector) ? document.querySelector(selector).textContent : null);
	const add = document.getElementById('add-key');
	const row = document.getElementById('how-to').getBoundingClientRect();
	return {
		title: text('#provider-title'),
		state: text('#provider-state'),
		addKey: shown('#add-key') ? (add.classList.contains('primary') ? 'lime button' : 'text link') : null,
		addKeyHeight: Math.round(add.getBoundingClientRect().height),
		howTo: shown('#how-to'),
		howToHeight: Math.round(row.height),
		how: shown('#how-title'),
		caps: ['#fold-keys', '#unfold-keys', '#scroll-keys'].filter(shown),
		sameLine: shown('#fold-keys') && Math.abs(document.getElementById('fold-keys').getBoundingClientRect().top - document.getElementById('unfold-keys').getBoundingClientRect().top) < 2,
		spoken: [...document.querySelectorAll('#how-to .keys > span:not(.way-scroll)')].map((el) => el.textContent),
	};
})()`;

test('lane 24: the popup says what is true: off on a site with no key pitch, off on a page that is not a site, a quieter add a key until the reader has folded, one line of keys once the hint was seen, and an urgent trial with an icon', async ({ headless }) => {
	test.setTimeout(240_000);
	const seen: Record<string, unknown> = {};
	for (const [lang, table] of [['en', en], ['ko', ko]] as const) {
		const h = await launch({ headless, lang });
		try {
			await worker(h).evaluate(() => chrome.storage.local.set({ hintSeen: false }));
			await h.navigate(fixtures.wiki);
			const host = new URL(h.page.url()).hostname;
			const read = async (name: string, on = h.page) => {
				const popup = await h.openPopup(on);
				seen[`${lang} ${name}`] = await popup.evaluate(readPopupState);
				for (const scheme of ['light', 'dark'] as const) {
					await popup.colorScheme(scheme);
					await popup.screenshot(await fresh(`p5h-popup-${name.replaceAll(/\W+/g, '-')}-${lang}-${scheme}`));
					expect(lowContrast(await popup.evaluate<Pair[]>(contrastProbe)), `${lang} ${name} ${scheme}`).toEqual([]);
				}
				await popup.close();
			};
			await read('free on a site, first time');

			await worker(h).evaluate((host) => chrome.storage.local.set({ disabledSites: [host] }), host);
			await read('off on this site');
			await worker(h).evaluate(() => chrome.storage.local.set({ disabledSites: [] }));

			const blank = await h.context.newPage();
			await blank.goto('chrome://version');
			await read('not a web page', blank);
			await blank.close();

			await worker(h).evaluate(() => chrome.storage.local.set({ hintSeen: true }));
			await read('hint seen');

			await h.page.bringToFront();
			await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
			const { x, y } = await h.pointAt('#mw-content-text section > p:not(.mw-empty-elt) >> nth=1');
			await h.foldAt(x, y, 1);
			await expect.poll(() => worker(h).evaluate(async () => (await chrome.storage.local.get('hasFolded')).hasFolded), { message: `${lang} a fold on a page counts` }).toBe(true);
			await read('has folded');

			await worker(h).evaluate(() => chrome.storage.local.remove('hasFolded'));
			const settings = await openSettings(h);
			await (await sampleSession(settings)).wheel(1);
			await expect.poll(() => worker(h).evaluate(async () => (await chrome.storage.local.get('hasFolded')).hasFolded), { message: `${lang} a fold in the sample counts` }).toBe(true);
			await settings.close();

			await worker(h).evaluate((account) => chrome.storage.local.set({ account }), { kind: 'pro', trialEndsAt: inDays(1), remainingPercent: 8, resetsAt: inDays(20) });
			await h.page.bringToFront();
			const urgent = await h.openPopup();
			seen[`${lang} urgent`] = await urgent.evaluate(`(() => { const el = document.getElementById('trial-left'); return { urgent: el.classList.contains('urgent'), icon: getComputedStyle(el, '::before').maskImage.includes('svg') }; })()`);
			await urgent.close();
			await worker(h).evaluate((account) => chrome.storage.local.set({ account }), { kind: 'pro', trialEndsAt: inDays(20), remainingPercent: 72, resetsAt: inDays(20) });
			const calm = await h.openPopup();
			seen[`${lang} calm`] = await calm.evaluate(`(() => { const el = document.getElementById('trial-left'); return { urgent: el.classList.contains('urgent'), icon: getComputedStyle(el, '::before').content }; })()`);
			await calm.close();
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
		const row = (name: string) => seen[`${lang} ${name}`] as { title: string; addKey: string | null; addKeyHeight: number; howToHeight: number };
		const noKey = table.popupNoKeyBody('OpenGateway');
		expect(row('free on a site, first time')).toMatchObject({ title: table.popupNoKeyTitle, state: noKey, addKey: 'text link', howTo: true, how: true, caps: ['#fold-keys', '#unfold-keys', '#scroll-keys'] });
		expect(row('off on this site')).toMatchObject({ title: table.popupSiteOff, howTo: false, addKey: null, state: null });
		expect(row('not a web page')).toMatchObject({ title: table.popupPageOff, state: null, addKey: null, howTo: false });
		expect(row('hint seen')).toMatchObject({ howTo: true, how: false, caps: ['#fold-keys', '#unfold-keys', '#scroll-keys'], sameLine: true, spoken: [table.popupFold, table.popupUnfold] });
		expect(row('hint seen').howToHeight, `${lang} the row collapses`).toBeLessThan(row('free on a site, first time').howToHeight);
		expect(row('has folded')).toMatchObject({ addKey: 'lime button', title: table.popupNoKeyTitle });
		expect(row('free on a site, first time').addKeyHeight, `${lang} the link is quieter than the button`).toBeLessThan(row('has folded').addKeyHeight);
		expect(seen[`${lang} urgent`]).toEqual({ urgent: true, icon: true });
		expect(seen[`${lang} calm`]).toEqual({ urgent: false, icon: 'none' });
	}
	console.log(JSON.stringify(seen, null, 1));
});

test('lane 25: signed out, the popup is a named region that says what signing in unlocks, and Try it first opens settings at the sample with no key fields, in a new tab or the one already open', async ({ headless }) => {
	test.setTimeout(180_000);
	const seen: Record<string, unknown> = {};
	for (const lang of langs) {
		const h = await launch({ headless, lang, account: null });
		try {
			await h.navigate(fixtures.wiki);
			const popup = await h.openPopup();
			seen[lang] = await popup.evaluate(`(() => {
				const region = document.getElementById('signed-out');
				const link = document.getElementById('try-first');
				const button = document.getElementById('continue').getBoundingClientRect();
				return {
					name: document.getElementById(region.getAttribute('aria-labelledby')).textContent,
					lines: [...region.querySelectorAll('p')].map((p) => p.textContent),
					link: link.textContent,
					under: link.getBoundingClientRect().top >= button.bottom,
				};
			})()`);
			for (const scheme of ['light', 'dark'] as const) {
				await popup.colorScheme(scheme);
				await popup.screenshot(await fresh(`p5h-popup-signed-out-${lang}-${scheme}`));
				expect(lowContrast(await popup.evaluate<Pair[]>(contrastProbe)), `${lang} ${scheme}`).toEqual([]);
			}
			const [settings] = await Promise.all([h.context.waitForEvent('page'), popup.click('#try-first')]);
			await settings.waitForLoadState('load');
			await expect(settings.locator('#sample-stage')).toBeFocused();
			expect(await settings.evaluate(() => location.hash), lang).toBe('');
			expect(await settings.locator('#key').isVisible(), `${lang} no key field`).toBe(false);
			await settings.evaluate(() => (document.activeElement as HTMLElement).blur());
			await h.page.bringToFront();
			const again = await h.openPopup();
			await again.click('#try-first');
			await expect(settings.locator('#sample-stage')).toBeFocused();
			expect((await h.tabUrls()).filter((url) => url.startsWith(optionsUrl(h))), lang).toHaveLength(1);
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
		const store = storeTables[lang];
		expect(seen[lang]).toEqual({ name: store.popupSignedOutName, lines: [store.popupSignedOut, store.popupSignedOutUnlock], link: store.popupTryFirst, under: true });
	}
	console.log(JSON.stringify(seen, null, 1));
});

test('lane 26: a discarded settings tab is brought back instead of getting a second tab, by open settings and by add a key, which also loads it', async ({ h }) => {
	await h.navigate(fixtures.wiki);
	await openSettings(h);
	const settingsTabs = () => worker(h).evaluate(async (url) => (await chrome.tabs.query({ url: `${url}*` })).map((tab) => ({ discarded: tab.discarded, active: tab.active })), optionsUrl(h));
	await h.page.bringToFront();
	await worker(h).evaluate(async (url) => {
		const [tab] = await chrome.tabs.query({ url: `${url}*` });
		await chrome.tabs.discard(tab?.id ?? -1);
	}, optionsUrl(h));
	await expect.poll(settingsTabs).toEqual([{ discarded: true, active: false }]);
	const first = await h.openPopup();
	await first.click('#settings');
	await expect.poll(async () => (await settingsTabs()).map(({ active }) => active)).toEqual([true]);
	await h.page.bringToFront();
	const second = await h.openPopup();
	await second.click('#add-key');
	await expect.poll(settingsTabs).toEqual([{ discarded: false, active: true }]);
	expect(errors(h)).toEqual([]);
});

test('lane 22: the undo offer stays while its button has focus or the pointer, however the focus got there, ends soon after both leave, and a newer message outlives the old timer', async ({ h }) => {
	test.setTimeout(120_000);
	await stubKeyChecks(h);
	const saved = { chosen: 'opengateway', opengateway: { apiKey: 'sk-old-og' } };
	const pastTheWindow = 8_600;

	await seedProviders(h, saved);
	const focused = await openSettings(h);
	await focused.locator('#remove-key').click();
	await expect(focused.locator('#undo')).toBeFocused();
	await focused.mouse.move(2, 2);
	await focused.waitForTimeout(pastTheWindow);
	await expect(focused.locator('#undo'), 'focus from a mouse click keeps it').toBeVisible();
	await focused.locator('h1').click();
	await expect(focused.locator('#undo'), 'it ends once focus leaves').toBeHidden({ timeout: 1_500 });
	await focused.close();

	await seedProviders(h, saved);
	const hovered = await openSettings(h);
	await hovered.locator('#remove-key').click();
	await hovered.locator('h1').click();
	await hovered.locator('#undo').hover();
	await hovered.waitForTimeout(pastTheWindow);
	await expect(hovered.locator('#undo'), 'the pointer keeps it').toBeVisible();
	await hovered.mouse.move(2, 2);
	await expect(hovered.locator('#undo'), 'it ends once the pointer leaves').toBeHidden({ timeout: 1_500 });
	await hovered.close();

	await seedProviders(h, saved);
	const newer = await openSettings(h);
	await newer.locator('#remove-key').click();
	await newer.locator('#undo').click();
	await expect(newer.locator('#status')).toHaveAttribute('data-tone', 'success');
	const restored = await newer.locator('#status').textContent();
	await newer.waitForTimeout(pastTheWindow);
	await expect(newer.locator('#status'), 'the old timer does not wipe the newer message').toHaveText(restored ?? '');
	await newer.close();
	expect(errors(h)).toEqual([]);
});

const readSiteRow = `({
	site: { disabled: document.getElementById('site').disabled, checked: document.getElementById('site').getAttribute('aria-checked') },
	host: document.getElementById('site-host').textContent,
})`;

async function buildWithoutScriptOn(pattern: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'tfold-no-script-'));
	await cp(extensionDir, dir, { recursive: true });
	const file = path.join(dir, 'manifest.json');
	const manifest = JSON.parse(await readFile(file, 'utf8')) as { content_scripts: { exclude_matches?: string[] }[] };
	(manifest.content_scripts[0] as { exclude_matches?: string[] }).exclude_matches = [pattern];
	await writeFile(file, JSON.stringify(manifest));
	return dir;
}

test('lane 27: on a web page where no content script runs, as on the Web Store, the popup reads as not a site with or without a key, and a page with the script keeps its state', async ({ headless }) => {
	test.setTimeout(240_000);
	const dist = await buildWithoutScriptOn('*://*/reading-en/*');
	const seen: Record<string, unknown> = {};
	try {
		for (const [lang, table] of [['en', en], ['ko', ko]] as const) {
			const h = await launch({ headless, lang }, dist);
			try {
				await h.navigate('/reading-en/');
				const read = async (name: string) => {
					const popup = await h.openPopup();
					const readyMs = await popup.evaluate<number>(`Math.round(performance.getEntriesByName('tfold-ready')[0].startTime)`);
					seen[`${lang} ${name}`] = { ...(await popup.evaluate<object>(readPopupState)), ...(await popup.evaluate<object>(readSiteRow)), readyMs };
					for (const scheme of ['light', 'dark'] as const) {
						await popup.colorScheme(scheme);
						await popup.screenshot(await fresh(`p5h-popup-no-script-${name.replaceAll(/\W+/g, '-')}-${lang}-${scheme}`));
						expect(lowContrast(await popup.evaluate<Pair[]>(contrastProbe)), `${lang} ${name} ${scheme}`).toEqual([]);
					}
					await popup.close();
				};
				const notASite = { title: table.popupPageOff, state: null, addKey: null, howTo: false, site: { disabled: true, checked: 'false' }, host: table.popupNoSite };

				await read('no key');
				expect(seen[`${lang} no key`]).toMatchObject(notASite);

				await seedProviders(h, { chosen: 'opengateway', opengateway: { apiKey: 'sk-test-saved' } });
				await read('with a key');
				expect(seen[`${lang} with a key`]).toMatchObject(notASite);

				const { x, y } = await h.pointAt('p');
				await h.foldAt(x, y, 2);
				await h.page.waitForTimeout(300);
				expect(await h.page.locator('[data-tfold-overlay]').count(), 'a fold folds nothing here').toBe(0);

				await h.navigate('/reading-en-more/');
				await read('a page with the script');
				expect(seen[`${lang} a page with the script`]).toMatchObject({
					title: table.popupProvider('OpenGateway'),
					state: table.popupKeySaved,
					howTo: true,
					site: { disabled: false, checked: 'true' },
					host: new URL(h.page.url()).hostname,
				});
				expect(errors(h)).toEqual([]);
			} finally {
				await h.close();
			}
		}
	} finally {
		await rm(dist, { recursive: true, force: true });
	}
	console.log(JSON.stringify(seen, null, 1));
});

test('lane 28: a tab still loading and a busy tab never read as not a site, and the popup stays on them once the script has answered', async ({ headless }) => {
	test.setTimeout(120_000);
	const held: http.ServerResponse[] = [];
	const server = http.createServer((_, response) => {
		response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
		response.write(`<!doctype html><title>Slow</title><main><p>${'The first words of a page that is still on its way to the reader. '.repeat(4)}</p>`);
		held.push(response);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const h = await launch({ headless, allowLiveHosts: ['127.0.0.1'] });
	try {
		const watchTitles = `(() => {
			const read = () => [document.getElementById('provider-title').textContent, document.getElementById('site').disabled].join(' | ');
			window.titles = [read()];
			new MutationObserver(() => window.titles.push(read())).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
		})()`;
		const quick = `${en.popupNoKeyTitle} | false`;
		const distinct = (titles: string[]) => [...new Set(titles)];

		await h.page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/slow`, { waitUntil: 'commit' });
		const loading = await h.openPopup();
		await loading.evaluate(watchTitles);
		await h.page.waitForTimeout(1500);
		expect(await worker(h).evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.status), 'the tab is still loading').toBe('loading');
		expect(distinct(await loading.evaluate<string[]>('window.titles')), 'while loading').toEqual([quick]);
		held.forEach((response) => response.end('</main>'));
		await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
		await h.page.waitForTimeout(400);
		expect(distinct(await loading.evaluate<string[]>('window.titles')), 'after it loaded').toEqual([quick]);
		await loading.close();

		await h.navigate(fixtures.wiki);
		const busy = h.page.evaluate(() => {
			const until = Date.now() + 2000;
			while (Date.now() < until);
		});
		const onBusy = await h.openPopup();
		await onBusy.evaluate(watchTitles);
		await busy;
		await h.page.waitForTimeout(300);
		const busyPageReadyMs = await onBusy.evaluate<number>(`Math.round(performance.getEntriesByName('tfold-ready')[0].startTime)`);
		expect(distinct(await onBusy.evaluate<string[]>('window.titles')), 'on a busy page').toEqual([quick]);
		await onBusy.close();
		console.log(JSON.stringify({ busyPageReadyMs }));
		expect(errors(h)).toEqual([]);
	} finally {
		held.forEach((response) => response.end());
		await h.close();
		await new Promise((resolve) => server.close(resolve));
	}
});

test('lane 29: with OpenGateway chosen and only an OpenRouter key, the route and the backup hint say neither service is asked, no request leaves, and a saved OpenGateway key makes them say the backup is asked', async ({ headless }) => {
	test.setTimeout(180_000);
	for (const [lang, table] of [['en', en], ['ko', ko]] as const) {
		const h = await launch({ headless, lang });
		try {
			const stub = await stubKeyChecks(h);
			await seedProviders(h, { chosen: 'opengateway', openrouter: { apiKey: 'sk-test-or' } });
			const settings = await openSettings(h);
			await expect(settings.locator('#route')).toHaveText(table.routeNoKeyOther('OpenGateway', 'OpenRouter'));
			await expect(settings.locator('#backup-hint')).toBeVisible();
			await expect(settings.locator('#backup-hint')).toHaveText(table.backupHintNoFirst('OpenGateway', 'OpenRouter'));
			await settings.locator('#provider-section').screenshot({ path: await fresh(`p5h-chosen-no-key-${lang}`), animations: 'disabled' });

			await h.page.bringToFront();
			await h.navigate(fixtures.wiki);
			const { x, y } = await h.pointAt('#mw-content-text section > p:not(.mw-empty-elt) >> nth=1');
			await h.foldAt(x, y, 1);
			await expect(h.page.locator('[data-tfold-overlay]')).toHaveCount(1);
			await expect.poll(() => h.logs.some((entry) => entry.source === 'worker' && entry.text.startsWith('fold skipped, no API key'))).toBe(true);
			expect(stub.seen, 'no key check').toEqual([]);

			await settings.bringToFront();
			await settings.locator('#key').fill('sk-test-og');
			await settings.locator('#save').click();
			await saveTone(settings, 'success');
			await expect(settings.locator('#route')).toHaveText(table.routeBoth('OpenGateway', 'OpenRouter'));
			await expect(settings.locator('#backup-hint')).toHaveText(table.backupHint('OpenGateway', 'OpenRouter'));
			await settings.close();
		} finally {
			await h.close();
		}
	}
});

type SampleCalls = { computed: number; messages: { type: string }[]; storage: string[]; fetches: number; observed: string[] };

test('lane 30: the sample takes the look of its own paragraph at each level and theme, wakes for nothing outside its box, and folds with no request, no storage call and no worker message but the one note of a first fold', async ({ h }) => {
	test.setTimeout(120_000);
	const settings = await h.context.newPage();
	await settings.setViewportSize({ width: 860, height: 900 });
	await settings.addInitScript(() => {
		const calls = { computed: 0, messages: [] as unknown[], storage: [] as string[], fetches: 0, observed: [] as string[] };
		Object.assign(window, { sampleCalls: calls });
		const computed = window.getComputedStyle.bind(window);
		window.getComputedStyle = (...args) => {
			calls.computed++;
			return computed(...args);
		};
		const fetched = window.fetch.bind(window);
		window.fetch = (...args) => {
			calls.fetches++;
			return fetched(...args);
		};
		window.MutationObserver = class extends MutationObserver {
			override observe(...args: Parameters<MutationObserver['observe']>) {
				if (args[0] instanceof Element) calls.observed.push(args[0].id || args[0].localName);
				super.observe(...args);
			}
		};
		const send = chrome.runtime.sendMessage.bind(chrome.runtime) as (...args: unknown[]) => unknown;
		(chrome.runtime as { sendMessage: unknown }).sendMessage = (...args: unknown[]) => {
			calls.messages.push(args[0]);
			return send(...args);
		};
		for (const [name, area] of [['local', chrome.storage.local], ['sync', chrome.storage.sync]] as const) {
			for (const method of ['get', 'set', 'remove'] as const) {
				const call = (area[method] as (...args: unknown[]) => unknown).bind(area);
				Object.defineProperty(area, method, {
					value: (...args: unknown[]) => {
						calls.storage.push(`${name}.${method}`);
						return call(...args);
					},
				});
			}
		}
	});
	await settings.goto(optionsUrl(h));
	await expect(settings.locator('#route')).not.toBeEmpty();
	await settings.waitForTimeout(300);
	const calls = () => settings.evaluate(() => (window as unknown as { sampleCalls: SampleCalls }).sampleCalls);
	const reset = () => settings.evaluate(() => Object.assign((window as unknown as { sampleCalls: SampleCalls }).sampleCalls, { computed: 0, messages: [], storage: [], fetches: 0, observed: [] }));
	const look = () =>
		settings.evaluate(() => {
			const read = (el: Element | null) => {
				const { color, fontSize, lineHeight, fontWeight, backgroundColor } = getComputedStyle(el as Element);
				return { color, fontSize, lineHeight, fontWeight, backgroundColor };
			};
			return { fold: read(document.querySelector('#sample-stage [data-tfold-overlay]')), page: read(document.getElementById('sample-text')) };
		});
	const session = await sampleSession(settings);
	await reset();
	const seen: Record<string, unknown> = {};
	for (const level of [1, 2, 3] as const) {
		await session.wheel(1);
		expect((await sampleText(settings)).level).toBe(String(level));
		for (const scheme of ['light', 'dark'] as const) {
			await settings.emulateMedia({ colorScheme: scheme });
			await settings.waitForTimeout(120);
			const { fold, page } = await look();
			seen[`${level} ${scheme}`] = fold;
			expect(fold, `level ${level} ${scheme}`).toEqual(page);
		}
		await settings.emulateMedia({ colorScheme: 'light' });
	}
	const folding = await calls();
	expect(folding.messages.map(({ type }) => type), 'one note of the first fold, and nothing asks for a fold').toEqual(['note-fold']);
	expect(folding.storage, 'no storage call').toEqual([]);
	expect(folding.fetches, 'no request').toBe(0);
	expect(new Set(folding.observed), 'only its own box is watched').toEqual(new Set(['sample-stage']));

	await session.wheel(-1);
	await settings.waitForTimeout(400);
	await reset();
	await settings.evaluate(async () => {
		const others = [document.documentElement, document.body, document.getElementById('keyboard') as HTMLElement];
		for (let i = 0; i < 30; i++) {
			for (const el of others) el.setAttribute('data-elsewhere', String(i));
			(document.getElementById('sample-next') as HTMLElement).append(' ');
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	});
	expect((await calls()).computed, 'attributes and text outside the box read no style').toBe(0);
	expect(await settings.evaluate(() => document.querySelectorAll('[data-tfold-overlay]').length)).toBe(1);
	console.log(JSON.stringify(seen));
	await settings.close();
	expect(errors(h)).toEqual([]);
});
