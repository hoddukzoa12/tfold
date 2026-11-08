import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { failedWaitMs } from '../../src/messages.ts';
import { fixtures, launch, foldAt, pointAt, type Harness, type Point } from '../harness.ts';
import { expect, inKorean, test } from '../lane.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p5b');
const latchMs = 400;
const koWiki = '/wikipedia-ko-black-hole/';
const wikiParagraphs = '#mw-content-text section > p:not(.mw-empty-elt):not([data-tfold-overlay])';
const otherSection = 11;
const hintKo = 'Ctrl 키를 누른 채 문단 위에서 아래로 스크롤하면 접히고, 위로 스크롤하면 펼쳐져요. 단축키는 Alt+Shift+↓, Alt+Shift+↑';
const hintEn = 'Hold Ctrl and scroll down over a paragraph to shorten it, up to bring it back. Or press Alt+Shift+↓, Alt+Shift+↑';
const failedKo = 'AI 요약을 만들지 못했어요 · 한 번 더 해 보세요';
const networkKo = '연결에 문제가 있어요 · 한 번 더 해 보세요';

const nth = (selector: string, index: number) => `${selector} >> nth=${index}`;
const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const workerLines = (h: Harness, prefix: string) =>
	h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith(prefix)).map((entry) => entry.text);
const worker = (h: Harness) => h.context.serviceWorkers().at(-1) ?? h.worker;
const optionsUrl = (h: Harness) => `chrome-extension://${h.extensionId}/options/options.html`;

async function fresh(slug: string): Promise<string> {
	const file = path.join(outDir, `${slug}.png`);
	await mkdir(outDir, { recursive: true });
	await rm(file, { force: true });
	return file;
}

type Reply = 'fold' | 'error' | { delayMs: number };
type Mock = { prompts: string[]; close(): Promise<void> };

function foldAnswer(prompt: string): string {
	const units = prompt.split(/^\[U\d+\][^\n]*\n/m).slice(1);
	return JSON.stringify({
		units: units.map((unit, n) => {
			const words = (/^ {2}0: (.*)$/m.exec(unit)?.[1] ?? '').match(/[\p{L}\p{N}]+/gu) ?? [];
			return { id: `U${n}`, takeaway: words.slice(0, 7).join(' '), reason: words.slice(7, 14).join(' '), evidence: [0] };
		}),
	});
}

async function mockProvider(h: Harness, replies: Reply[] = []): Promise<Mock> {
	const prompts: string[] = [];
	const server = http.createServer((request, response) => {
		const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
		if (request.method === 'OPTIONS') {
			response.writeHead(204, cors).end();
			return;
		}
		let raw = '';
		request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		request.on('end', () => {
			const prompt = (JSON.parse(raw) as { messages: { content: string }[] }).messages.at(-1)?.content ?? '';
			const reply = replies[prompts.length] ?? 'fold';
			prompts.push(prompt);
			if (reply === 'error') {
				response.writeHead(500, cors).end('{}');
				return;
			}
			const answer = () =>
				response.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(
					JSON.stringify({
						id: 'gen-mock',
						choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: foldAnswer(prompt) } }],
						usage: { prompt_tokens: 0, completion_tokens: 0 },
					}),
				);
			if (reply === 'fold') answer();
			else setTimeout(answer, reply.delayMs);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	await worker(h).evaluate((provider) => chrome.storage.local.set({ provider }), {
		kind: 'openai-compatible',
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: 'mock-key',
		model: 'mock/model',
	});
	return {
		prompts,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

const hintSeen = (h: Harness, seen = true) => worker(h).evaluate((hintSeen) => chrome.storage.local.set({ hintSeen }), seen);

const ready = (h: Harness) => expect.poll(() => h.readBlocks().then(() => true, () => false)).toBe(true);

async function watchKeys(page: Page): Promise<void> {
	await page.evaluate(() => {
		const seen: string[] = [];
		Object.assign(window, { __p5bKeys: seen });
		addEventListener('keydown', (event) => {
			if (['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) return;
			const held = ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'] as const;
			const combo = [...held.filter((key) => event[key]).map((key) => key.replace('Key', '')), event.code].join('+');
			seen.push(`${combo} ${event.defaultPrevented ? 'taken' : 'left to the page'}`);
		});
	});
}

const keysSeen = (page: Page) => page.evaluate(() => (window as unknown as { __p5bKeys: string[] }).__p5bKeys.splice(0));

type Overlay = { level: string | null; fold: string | null; badge: string | null; pending: boolean; cue: string; text: string | null };

function overlay(page: Page, index: number): Promise<Overlay> {
	return page.evaluate(
		({ selector, index }) => {
			const el = document.querySelectorAll(selector)[index];
			if (!el) throw new Error(`no paragraph ${index}`);
			const shown = el.nextElementSibling?.hasAttribute('data-tfold-overlay') ? el.nextElementSibling : null;
			return {
				level: shown?.getAttribute('data-tf-level') ?? null,
				fold: shown?.getAttribute('data-tf-fold') ?? null,
				badge: shown?.getAttribute('data-tf-badge') ?? null,
				pending: shown?.hasAttribute('data-tf-pending') ?? false,
				cue: shown ? getComputedStyle(shown).animationName : 'none',
				text: shown ? (shown.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
			};
		},
		{ selector: wikiParagraphs, index },
	);
}

async function settled(h: Harness, index: number, want: (shown: Overlay) => boolean, timeout = 15_000): Promise<Overlay> {
	await expect.poll(async () => want(await overlay(h.page, index)), { timeout, intervals: [100] }).toBe(true);
	return overlay(h.page, index);
}

async function pointOn(h: Harness, index: number): Promise<Point> {
	await h.page.evaluate(
		({ selector, index }) => {
			for (const marked of document.querySelectorAll('[data-p5b-target]')) marked.removeAttribute('data-p5b-target');
			const el = document.querySelectorAll(selector)[index];
			(el?.checkVisibility() ? el : el?.nextElementSibling)?.setAttribute('data-p5b-target', '');
		},
		{ selector: wikiParagraphs, index },
	);
	return h.pointAt('[data-p5b-target]');
}

async function foldBy(h: Harness, index: number, steps: number): Promise<void> {
	const point = await pointOn(h, index);
	await h.foldAt(point.x, point.y, steps);
	await h.page.waitForTimeout(latchMs + 100);
}

const folded = async (h: Harness) => (await h.readBlocks()).filter((block) => block.level !== 0).length;

const badge = (h: Harness) =>
	worker(h).evaluate(async () => {
		const [tab] = await chrome.tabs.query({ active: true });
		return tab?.id === undefined ? null : chrome.action.getBadgeText({ tabId: tab.id });
	});

async function switchSite(h: Harness): Promise<void> {
	const popup = await h.openPopup();
	const checked = () => popup.evaluate<string | null>(`document.getElementById('site').getAttribute('aria-checked')`);
	const before = await checked();
	await popup.click('#site');
	await expect.poll(checked).not.toBe(before);
	await popup.close();
}

async function clip(page: Page, top: number, bottom: number, file: string): Promise<void> {
	const width = page.viewportSize()?.width ?? 1280;
	await page.screenshot({ path: file, clip: { x: 0, y: Math.max(0, top - 24), width, height: Math.min(700, bottom - top + 48) } });
}

const boxOf = (page: Page, index: number) =>
	page.evaluate(
		({ selector, index }) => {
			const el = document.querySelectorAll(selector)[index];
			const shown = el?.checkVisibility() ? el : el?.nextElementSibling;
			const box = shown?.getBoundingClientRect();
			return { top: box?.top ?? 0, bottom: box?.bottom ?? 0 };
		},
		{ selector: wikiParagraphs, index },
	);

test.describe('lanes with a mock model', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	inKorean('lane 1: resting on a paragraph shows one quiet hint in the browser language once, the page does not move, and the hint goes on the first fold or after a few seconds', async ({
		h,
		headless,
	}) => {
		const png = await fresh('p5b-hint');
		const layout = () =>
			h.page.evaluate(
				(selector) => ({
					height: document.documentElement.scrollHeight,
					y: scrollY,
					boxes: [...document.querySelectorAll(selector)].slice(0, 20).map((el) => {
						const box = el.getBoundingClientRect();
						return `${box.x},${box.y},${box.width},${box.height}`;
					}),
				}),
				wikiParagraphs,
			);
		const hintAt = (page: Page, index: number) =>
			page.evaluate(
				({ selector, index }) => {
					const host = document.querySelector('tf-hint');
					const tip = host?.shadowRoot?.querySelector('div');
					const paragraph = document.querySelectorAll(selector)[index]?.getBoundingClientRect();
					const box = tip?.getBoundingClientRect();
					if (!host || !box || !paragraph) return null;
					return {
						text: tip?.textContent ?? '',
						position: getComputedStyle(host).position,
						gap: box.bottom <= paragraph.top ? paragraph.top - box.bottom : box.top - paragraph.bottom,
						left: box.left - paragraph.left,
						top: box.top,
						bottom: paragraph.bottom,
					};
				},
				{ selector: wikiParagraphs, index },
			);
		const hint = h.page.locator('tf-hint');

		await h.navigate(koWiki);
		await h.page.waitForTimeout(500);
		await h.pointAt(nth(wikiParagraphs, 1));
		const rested = Date.now();
		const before = await layout();
		await expect(hint).toHaveCount(1, { timeout: 4000 });
		const showedAfter = Date.now() - rested;
		const during = await layout();
		const korean = await hintAt(h.page, 1);
		if (korean) await clip(h.page, korean.top, korean.bottom, png);
		await expect(hint).toHaveCount(0, { timeout: 12_000 });
		const goneAfter = Date.now() - rested;

		await h.pointAt(nth(wikiParagraphs, 3));
		await h.page.waitForTimeout(2500);
		const elsewhere = await hint.count();
		await h.page.reload({ waitUntil: 'load' });
		await h.page.waitForTimeout(500);
		await h.pointAt(nth(wikiParagraphs, 1));
		await h.page.waitForTimeout(2500);
		const afterReload = await hint.count();
		await h.navigate(fixtures.wiki);
		await h.page.waitForTimeout(500);
		await h.pointAt(nth(wikiParagraphs, 1));
		await h.page.waitForTimeout(2500);
		const onEnglish = await hint.count();
		const seen = await worker(h).evaluate(() => chrome.storage.local.get('hintSeen'));

		const second = await launch({ headless });
		const { english, afterFold } = await (async () => {
			try {
				await second.navigate(fixtures.wiki);
				await second.page.waitForTimeout(500);
				const point = await second.pointAt(nth(wikiParagraphs, 1));
				await expect(second.page.locator('tf-hint')).toHaveCount(1, { timeout: 4000 });
				const shown = await hintAt(second.page, 1);
				await second.foldAt(point.x, point.y, 1);
				await second.page.waitForTimeout(300);
				return { english: shown, afterFold: await second.page.locator('tf-hint').count() };
			} finally {
				await second.close();
			}
		})();

		console.log(`Korean hint after ${showedAfter} ms, gone after ${goneAfter} ms: ${JSON.stringify(korean)}`);
		console.log(`English hint: ${JSON.stringify(english)}; hints after the first fold: ${afterFold}`);
		console.log(`hints later: another paragraph ${elsewhere}, after a reload ${afterReload}, on another page ${onEnglish}`);
		expect(showedAfter).toBeGreaterThanOrEqual(900);
		expect(korean).toMatchObject({ text: hintKo, position: 'fixed' });
		expect(korean?.gap).toBeGreaterThanOrEqual(0);
		expect(korean?.gap).toBeLessThanOrEqual(16);
		expect(Math.abs(korean?.left ?? Infinity)).toBeLessThanOrEqual(1);
		expect(during).toEqual(before);
		expect(goneAfter).toBeGreaterThan(4000);
		expect(goneAfter).toBeLessThan(9000);
		expect([elsewhere, afterReload, onEnglish]).toEqual([0, 0, 0]);
		expect(seen).toEqual({ hintSeen: true });
		expect(english).toMatchObject({ text: hintEn, position: 'fixed' });
		expect(afterFold).toBe(0);
		expect(errors(h)).toEqual([]);
	});

	test('lane 2: Option+Shift+Down folds and Option+Shift+Up unfolds the paragraph under the pointer through the fold path, takes the key only when the level changes, and leaves plain Alt+Up and Alt+Down to the page', async ({
		h,
	}) => {
		const png = await fresh('p5b-keyboard');
		const mock = await mockProvider(h, [{ delayMs: 600 }]);
		await hintSeen(h);
		await h.worker.evaluate(() => chrome.storage.sync.set({ autoTranslate: false }));
		await h.navigate(koWiki);
		await ready(h);
		await watchKeys(h.page);
		const scrolls = async (keys: string) => {
			const before = await h.page.evaluate(() => scrollY);
			await h.press(keys);
			let at = before;
			for (let still = 0, polled = 0; still < 3 && polled < 30; polled++) {
				await h.page.waitForTimeout(100);
				const now = await h.page.evaluate(() => scrollY);
				still = now === at ? still + 1 : 0;
				at = now;
			}
			return Math.round(at - before);
		};
		await h.pointAt(nth(wikiParagraphs, 1));
		const moved = { 'Alt+Shift+Up': await scrolls('Alt+Shift+ArrowUp'), 'Alt+Down': await scrolls('Alt+ArrowDown'), 'Alt+Up': await scrolls('Alt+ArrowUp') };
		const atFull = { keys: await keysSeen(h.page), folded: await folded(h) };
		await pointOn(h, 1);
		await h.press('Alt+Shift+ArrowDown');
		const local = await overlay(h.page, 1);
		const brief = await settled(h, 1, (shown) => shown.fold === 'model');
		await h.press('Alt+Shift+ArrowDown');
		await h.press('Alt+Shift+ArrowDown');
		const takeaway = await overlay(h.page, 1);
		const folding = await keysSeen(h.page);
		await h.page.waitForFunction(() => document.querySelector('tfold-ghosts, tfold-gap') === null);
		const box = await boxOf(h.page, 1);
		await clip(h.page, box.top - 60, box.bottom + 60, png);
		const levels = (await h.readBlocks()).map((block) => block.level);
		await h.press('Alt+Shift+ArrowDown');
		await h.press('Alt+ArrowDown');
		await h.press('Alt+ArrowUp');
		const atTakeaway = { keys: await keysSeen(h.page), level: (await overlay(h.page, 1)).level };
		await pointOn(h, 1);
		await h.press('Alt+Shift+ArrowUp');
		const key = await overlay(h.page, 1);
		for (let i = 0; i < 3; i++) await h.press('Alt+Shift+ArrowUp');
		const unfolding = { keys: await keysSeen(h.page), folded: await folded(h) };

		await h.page.evaluate(() => {
			document.addEventListener('keydown', (event) => {
				if (event.altKey && event.key === 'ArrowDown') event.preventDefault();
			});
		});
		await h.press('Alt+Shift+ArrowDown');
		const pageTookIt = await folded(h);
		await h.page.evaluate(() => {
			for (const code of ['ArrowUp', 'ArrowDown']) {
				document.body.dispatchEvent(new KeyboardEvent('keydown', { key: code, code, altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
			}
		});
		await h.page.waitForTimeout(300);
		const scripted = await folded(h);
		await mock.close();

		console.log(`at Full: ${JSON.stringify(atFull)}; the page scrolled by ${JSON.stringify(moved)}`);
		console.log(`Alt+Shift+Down: ${JSON.stringify(local)} then ${JSON.stringify(brief)}; two more: ${JSON.stringify(takeaway)}; keys ${JSON.stringify(folding)}`);
		console.log(`at Takeaway: ${JSON.stringify(atTakeaway)}; Alt+Shift+Up: ${JSON.stringify(key)}; back to Full: ${JSON.stringify(unfolding)}`);
		console.log(`levels at Takeaway ${JSON.stringify(levels)}; folded after the page took the key ${pageTookIt}, from a script ${scripted}`);
		console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
		const taken = 'alt+shift+ArrowDown taken';
		expect(atFull).toEqual({
			keys: ['alt+shift+ArrowUp left to the page', 'alt+ArrowDown left to the page', 'alt+ArrowUp left to the page'],
			folded: 0,
		});
		expect(moved['Alt+Shift+Up']).toBe(0);
		expect(moved['Alt+Down']).toBeGreaterThan(200);
		expect(moved['Alt+Up']).toBeLessThan(-200);
		expect(local).toMatchObject({ level: '1', fold: 'local', pending: true });
		expect(brief).toMatchObject({ level: '1', fold: 'model', pending: false, badge: null });
		expect(takeaway).toMatchObject({ level: '3', fold: 'model' });
		expect(folding).toEqual([taken, taken, taken]);
		expect(levels.filter((level) => level !== 0)).toEqual([3]);
		expect(atTakeaway).toEqual({
			keys: ['alt+shift+ArrowDown left to the page', 'alt+ArrowDown left to the page', 'alt+ArrowUp left to the page'],
			level: '3',
		});
		expect(key).toMatchObject({ level: '2', fold: 'model' });
		expect(unfolding).toEqual({
			keys: ['alt+shift+ArrowUp taken', 'alt+shift+ArrowUp taken', 'alt+shift+ArrowUp taken', 'alt+shift+ArrowUp left to the page'],
			folded: 0,
		});
		expect(pageTookIt).toBe(0);
		expect(scripted).toBe(0);
		expect(mock.prompts).toHaveLength(1);
		expect(errors(h)).toEqual([]);
	});

	test('lane 3: the popup switch turns tfold off for the site in every open window and restores Full, stays off after a reload, and turns back on from the popup or the settings page', async ({
		h,
	}) => {
		const png = await fresh('p5b-toggle');
		const mock = await mockProvider(h);
		await hintSeen(h);
		const host = new URL(h.baseURL).hostname;
		const hidden = () => h.page.evaluate(() => document.querySelectorAll('[data-tfold-overlay], [data-tfold-hidden]').length);
		await h.navigate(koWiki);
		await foldBy(h, 1, 1);
		await foldBy(h, 4, 2);
		await settled(h, 1, (shown) => shown.fold === 'model');
		const before = { folded: await folded(h), badge: await badge(h) };
		const [other] = await Promise.all([
			h.context.waitForEvent('page'),
			h.page.evaluate((url) => void window.open(url, 'tfold-other', 'popup,width=1000,height=700'), new URL(fixtures.wiki, h.baseURL).href),
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
		const visibility = await Promise.all([h.page, other].map((page) => page.evaluate(() => document.visibilityState)));
		const otherBefore = await foldOther();

		await switchSite(h);
		await expect.poll(() => folded(h)).toBe(0);
		await expect.poll(hidden).toBe(0);
		await expect.poll(otherFolds).toBe(0);
		await expect.poll(() => badge(h)).toBe('off');
		const off = { badge: await badge(h), sites: await worker(h).evaluate(() => chrome.storage.local.get('disabledSites')) };
		const otherWhileOff = await foldOther();
		const box = await boxOf(h.page, 1);
		await clip(h.page, box.top - 40, box.bottom + 200, png);
		await foldBy(h, 1, 1);
		await h.press('Alt+Shift+ArrowDown');
		await h.page.waitForTimeout(300);
		const whileOff = await folded(h);
		await h.page.reload({ waitUntil: 'load' });
		await expect.poll(() => badge(h)).toBe('off');
		await foldBy(h, 1, 1);
		const afterReload = await folded(h);

		await switchSite(h);
		await expect.poll(() => badge(h)).toBe('');
		await foldBy(h, 1, 1);
		const iconOn = await folded(h);

		await switchSite(h);
		await expect.poll(() => folded(h)).toBe(0);
		await h.navigate(optionsUrl(h));
		const listed = await h.page.locator('#sites li span').allTextContents();
		await h.page.locator('#sites li button').first().click();
		await expect(h.page.locator('#sites li')).toHaveCount(0);
		const empty = await h.page.locator('#no-sites').isVisible();
		const otherOn = await foldOther();
		await other.close();
		await h.navigate(koWiki);
		await expect.poll(() => badge(h)).toBe('');
		await foldBy(h, 1, 1);
		const optionsOn = await folded(h);
		const sites = await worker(h).evaluate(() => chrome.storage.local.get('disabledSites'));
		await mock.close();

		console.log(`before ${JSON.stringify(before)}; off ${JSON.stringify(off)}; folded while off ${whileOff}, after a reload ${afterReload}`);
		console.log(`another window on the site, both ${JSON.stringify(visibility)}: ${otherBefore} folded before, ${otherWhileOff} after the icon and a fold, ${otherOn} after options turned it on`);
		console.log(`on from the icon: ${iconOn} folded; options listed ${JSON.stringify(listed)}, then empty ${empty}; on from options: ${optionsOn} folded, ${JSON.stringify(sites)}`);
		expect(before).toEqual({ folded: 2, badge: '' });
		expect(off).toEqual({ badge: 'off', sites: { disabledSites: [host] } });
		expect(whileOff).toBe(0);
		expect(visibility).toEqual(['visible', 'visible']);
		expect([otherBefore, otherWhileOff, otherOn]).toEqual([1, 0, 1]);
		expect(afterReload).toBe(0);
		expect(iconOn).toBe(1);
		expect(listed).toEqual([host]);
		expect(empty).toBe(true);
		expect(optionsOn).toBe(1);
		expect(sites).toEqual({ disabledSites: [] });
		expect(errors(h)).toEqual([]);
	});

	test('lane 4: Enter twice on the copied counter in a React Brief counts twice, and focus stays on the copy', async ({ h }) => {
		const png = await fresh('p5b-focus');
		const mock = await mockProvider(h);
		await hintSeen(h);
		await h.navigate(fixtures.react);
		const counter = h.page.locator('#counter');
		await expect(counter).toHaveText('0');
		const point = await h.pointAt('#counter-paragraph');
		await h.foldAt(point.x, point.y, 1);
		await expect(h.page.locator('#counter-paragraph + [data-tfold-overlay][data-tf-fold="model"]')).toHaveCount(1);
		const copy = h.page.locator('#counter-paragraph + [data-tfold-overlay] button');
		await expect(copy).toHaveText('0');
		await copy.focus();
		const focusedCopy = () => h.page.evaluate(() => document.activeElement?.closest('[data-tfold-overlay]') !== null && document.activeElement?.localName === 'button');
		await h.press('Enter');
		await expect(counter).toHaveText('1');
		await expect(copy).toHaveText('1');
		const afterFirst = await focusedCopy();
		await h.press('Enter');
		await expect.poll(() => counter.textContent(), { timeout: 3000 }).toBe('2');
		await expect(copy).toHaveText('2');
		const afterSecond = await focusedCopy();
		await h.page.screenshot({ path: png });
		await mock.close();

		console.log(`after two Enter presses on the copy, the page counter reads ${await counter.textContent()}; focus on the copy after each: ${afterFirst}, ${afterSecond}`);
		expect([afterFirst, afterSecond]).toEqual([true, true]);
		expect(errors(h)).toEqual([]);
	});

	inKorean('lane 5: a waiting paragraph shows a quiet cue until the model fold lands, and a failure says so in Korean with a retry that works', async ({ h }) => {
		const cuePng = await fresh('p5b-pending');
		const badgePng = await fresh('p5b-failed');
		const mock = await mockProvider(h, [{ delayMs: 1500 }, 'error', { delayMs: 800 }]);
		await hintSeen(h);
		await h.navigate(koWiki);
		await foldBy(h, 1, 1);
		const waiting = await overlay(h.page, 1);
		const cueBox = await boxOf(h.page, 1);
		await clip(h.page, cueBox.top, cueBox.bottom, cuePng);
		const landed = await settled(h, 1, (shown) => shown.fold === 'model');

		await foldBy(h, otherSection, 1);
		const failed = await settled(h, otherSection, (shown) => shown.badge !== null);
		const badgeBox = await boxOf(h.page, otherSection);
		await clip(h.page, badgeBox.top, badgeBox.bottom, badgePng);
		await h.page.waitForTimeout(failedWaitMs);
		await foldBy(h, otherSection, 1);
		const retrying = await overlay(h.page, otherSection);
		const retried = await settled(h, otherSection, (shown) => shown.fold === 'model');
		await mock.close();

		console.log(`waiting ${JSON.stringify(waiting)}; landed ${JSON.stringify(landed)}`);
		console.log(`failed ${JSON.stringify(failed)}; retrying ${JSON.stringify(retrying)}; retried ${JSON.stringify(retried)}`);
		console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
		expect(waiting).toMatchObject({ level: '1', fold: 'local', pending: true, cue: 'tfold-pending', badge: null });
		expect(landed).toMatchObject({ level: '1', fold: 'model', pending: false, cue: 'none', badge: null });
		expect(failed).toMatchObject({ level: '1', fold: 'local', pending: false, badge: failedKo });
		expect(retrying).toMatchObject({ level: '2', fold: 'local', pending: true, badge: null });
		expect(retried).toMatchObject({ level: '2', fold: 'model', pending: false, badge: null });
		expect(mock.prompts).toHaveLength(3);
		expect(errors(h)).toEqual([]);
	});

	inKorean('lane 6: when the service worker never answers, the paragraph shows a failure badge within 13 s, and a fold again asks again', async ({ h }) => {
		const mock = await mockProvider(h);
		await hintSeen(h);
		await h.navigate(koWiki);
		await h.page.waitForTimeout(500);
		await worker(h).evaluate(() => {
			const local = chrome.storage.local;
			const get = local.get.bind(local) as (keys: unknown) => Promise<unknown>;
			let stalled = false;
			Object.assign(local, {
				get: (keys: unknown) => {
					if (stalled) return get(keys);
					stalled = true;
					return new Promise(() => {});
				},
			});
		});
		await foldBy(h, 1, 1);
		const tried = Date.now();
		const waiting = await overlay(h.page, 1);
		const failed = await settled(h, 1, (shown) => shown.badge !== null, 20_000);
		const waited = Date.now() - tried;
		await h.page.waitForTimeout(failedWaitMs);
		await foldBy(h, 1, 1);
		const retried = await settled(h, 1, (shown) => shown.fold === 'model');
		await mock.close();

		console.log(`the badge showed ${waited} ms after the how: ${JSON.stringify(failed)}; the retry: ${JSON.stringify(retried)}`);
		console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
		expect(waiting).toMatchObject({ level: '1', fold: 'local', pending: true });
		expect(waited).toBeLessThan(13_500);
		expect(failed).toMatchObject({ level: '1', fold: 'local', pending: false, badge: networkKo });
		expect(workerLines(h, 'fold received')).toHaveLength(2);
		expect(workerLines(h, 'fold request')).toHaveLength(1);
		expect(retried).toMatchObject({ level: '2', fold: 'model', badge: null });
		expect(mock.prompts).toHaveLength(1);
	});

	test('lane 7: the first-run hint never covers the paragraph under the pointer, at any window size, while it shows or while the page scrolls, and waits for a paragraph with room', async ({
		h,
	}) => {
		test.setTimeout(180_000);
		const png = await fresh('p5b-hint-narrow');
		type Seen = { visible: boolean; overlap: boolean; gap: number | null };
		const seen = (index: number) =>
			h.page.evaluate(
				({ selector, index }): Seen => {
					const el = document.querySelectorAll(selector)[index];
					const paragraph = (el?.checkVisibility() ? el : el?.nextElementSibling)?.getBoundingClientRect();
					const tip = document.querySelector('tf-hint')?.shadowRoot?.querySelector('div');
					const box = tip?.getBoundingClientRect();
					if (!paragraph || !tip || !box || getComputedStyle(tip).visibility !== 'visible') return { visible: false, overlap: false, gap: null };
					const overlap = box.left < paragraph.right && box.right > paragraph.left && box.top < paragraph.bottom && box.bottom > paragraph.top;
					return { visible: true, overlap, gap: box.bottom <= paragraph.top ? paragraph.top - box.bottom : box.top - paragraph.bottom };
				},
				{ selector: wikiParagraphs, index },
			);
		const pick = (most: 'tallest' | 'short') =>
			h.page.evaluate(
				({ selector, most }) => {
					const room = document.documentElement.scrollHeight - innerHeight;
					const sizes = [...document.querySelectorAll(selector)].flatMap((el, i) => {
						const words = (el.textContent ?? '').split(/\s+/).length;
						const range = document.createRange();
						range.selectNodeContents(el);
						const box = range.getBoundingClientRect();
						const reachable = box.top + scrollY - 10 <= room && box.top + scrollY >= innerHeight;
						return el.checkVisibility() && reachable && words >= 20 && !el.querySelector('img, table') ? [{ i, height: box.height }] : [];
					});
					if (most === 'tallest') return sizes.reduce((best, size) => (size.height > best.height ? size : best)).i;
					return sizes.find((size) => size.height > 60 && size.height < innerHeight / 3)?.i ?? -1;
				},
				{ selector: wikiParagraphs, most },
			);
		const restOn = async (index: number, top: number) => {
			const point = await h.page.evaluate(
				({ selector, index, top }) => {
					const el = document.querySelectorAll(selector)[index] as Element;
					const range = document.createRange();
					range.selectNodeContents(el);
					scrollBy(0, range.getBoundingClientRect().top - top);
					const middle = innerHeight / 2;
					const lines = [...range.getClientRects()]
						.filter((rect) => rect.width > 20 && rect.top >= 0 && rect.bottom <= innerHeight)
						.sort((a, b) => Math.abs((a.top + a.bottom) / 2 - middle) - Math.abs((b.top + b.bottom) / 2 - middle));
					for (const rect of lines) {
						const x = Math.round(rect.left + Math.min(rect.width / 2, 120));
						const y = Math.round((rect.top + rect.bottom) / 2);
						if (el.contains(document.elementFromPoint(x, y))) return { x, y };
					}
					const box = el.getBoundingClientRect();
					const at = document.elementFromPoint(box.left + 40, innerHeight / 2);
					throw new Error(
						`paragraph ${index} at ${Math.round(box.top)} to ${Math.round(box.bottom)} has no line under the pointer among ${lines.length}; at its middle is ${at?.localName}.${at?.className} ${at?.id}, ${JSON.stringify(lines.slice(0, 2))}`,
					);
				},
				{ selector: wikiParagraphs, index, top },
			);
			await h.page.mouse.move(point.x - 30, point.y - 10);
			await h.page.mouse.move(point.x, point.y, { steps: 6 });
		};
		const watch = async (index: number, ms: number) => {
			const samples: Seen[] = [];
			for (let waited = 0; waited < ms; waited += 250) {
				samples.push(await seen(index));
				await h.page.waitForTimeout(250);
			}
			return samples;
		};
		const firstVisit = async (url: string) => {
			await hintSeen(h, false);
			await h.navigate(url);
			await ready(h);
		};
		const cases = [
			{ url: koWiki, width: 560, height: 720 },
			{ url: fixtures.wiki, width: 1280, height: 400 },
			{ url: fixtures.wiki, width: 560, height: 720 },
			{ url: koWiki, width: 1280, height: 720 },
			{ url: koWiki, width: 800, height: 480 },
		];
		const results: string[] = [];
		const covered: string[] = [];
		const missing: string[] = [];
		for (const { url, width, height } of cases) {
			const size = `${url === koWiki ? 'ko' : 'en'} ${width}x${height}`;
			await h.page.setViewportSize({ width, height });
			await firstVisit(url);
			const tallest = await pick('tallest');
			await restOn(tallest, 10);
			const onTallest = await watch(tallest, 2500);
			const waited = onTallest.every((one) => !one.visible);
			if (!waited) await firstVisit(url);
			const short = await pick('short');
			await restOn(short, Math.round(height * 0.45));
			let onShort = await seen(short);
			for (let polled = 0; !onShort.visible && polled < 4000; polled += 100) {
				await h.page.waitForTimeout(100);
				onShort = await seen(short);
			}
			if (size === 'ko 560x720') {
				await h.page.waitForTimeout(300);
				const tip = await h.page.evaluate(() => document.querySelector('tf-hint')?.shadowRoot?.querySelector('div')?.getBoundingClientRect().top ?? 0);
				await clip(h.page, tip, (await boxOf(h.page, short)).bottom, png);
			}
			const whileScrolling: Seen[] = [];
			for (let i = 0; i < 8; i++) {
				const { top } = await boxOf(h.page, short);
				await h.page.mouse.wheel(0, Math.max(40, (top - 4) / (8 - i)));
				await h.page.waitForTimeout(120);
				whileScrolling.push(await seen(short));
			}
			const all = [...onTallest, onShort, ...whileScrolling];
			const visible = (samples: Seen[]) => `${samples.filter((one) => one.visible).length} of ${samples.length}`;
			results.push(
				`${size}: tallest paragraph ${tallest} at the top showed the hint ${visible(onTallest)}${waited ? ', so it waited' : ''}; paragraph ${short} ${JSON.stringify(onShort)}; while scrolling ${visible(whileScrolling)}`,
			);
			if (all.some((one) => one.overlap)) covered.push(size);
			if (!onShort.visible || (onShort.gap ?? Infinity) > 16) missing.push(size);
		}

		console.log(results.join('\n'));
		expect(covered).toEqual([]);
		expect(missing).toEqual([]);
		expect(errors(h)).toEqual([]);
	});

	test('lane 8: inside an input, a textarea or an editable area, and while text is selected, the shortcut stays with the page; a caret alone does not stop it', async ({
		h,
	}) => {
		const mock = await mockProvider(h);
		await hintSeen(h);
		await h.navigate(koWiki);
		await ready(h);
		await h.page.evaluate(() => {
			const fields = document.createElement('div');
			fields.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483646;display:grid;gap:4px;width:220px;background:#fff';
			fields.innerHTML =
				'<input id="p5b-input" value="one two three"><textarea id="p5b-textarea" rows="4">first paragraph\n\nsecond paragraph</textarea><div id="p5b-editable" contenteditable="true">alpha beta<br><br>gamma delta</div>';
			document.body.append(fields);
		});
		await watchKeys(h.page);
		await h.pointAt(nth(wikiParagraphs, 1));
		const inFields: { id: string; focus: string | undefined; folded: number }[] = [];
		for (const id of ['p5b-input', 'p5b-textarea', 'p5b-editable']) {
			await h.page.evaluate((id) => document.getElementById(id)?.focus(), id);
			await h.press('Alt+Shift+ArrowDown');
			inFields.push({ id, focus: await h.page.evaluate(() => document.activeElement?.id), folded: await folded(h) });
		}
		const fieldKeys = await keysSeen(h.page);
		await h.page.evaluate((selector) => {
			(document.activeElement as HTMLElement | null)?.blur();
			const other = document.querySelectorAll(selector)[2];
			if (other) document.getSelection()?.selectAllChildren(other);
		}, wikiParagraphs);
		const selectedBefore = await h.page.evaluate(() => document.getSelection()?.toString().length ?? 0);
		await h.press('Alt+Shift+ArrowDown');
		const withSelection = {
			keys: await keysSeen(h.page),
			folded: await folded(h),
			selectionKept: (await h.page.evaluate(() => document.getSelection()?.toString().length ?? 0)) === selectedBefore,
		};
		await h.page.evaluate((selector) => {
			const under = document.querySelectorAll(selector)[1];
			if (under) document.getSelection()?.collapse(under, 0);
		}, wikiParagraphs);
		await h.press('Alt+Shift+ArrowDown');
		const withCaret = { keys: await keysSeen(h.page), folded: await folded(h) };
		await mock.close();

		console.log(`in fields: ${JSON.stringify(inFields)}, keys ${JSON.stringify(fieldKeys)}`);
		console.log(`with ${selectedBefore} characters selected: ${JSON.stringify(withSelection)}; with a caret: ${JSON.stringify(withCaret)}`);
		const left = 'alt+shift+ArrowDown left to the page';
		expect(inFields).toEqual([
			{ id: 'p5b-input', focus: 'p5b-input', folded: 0 },
			{ id: 'p5b-textarea', focus: 'p5b-textarea', folded: 0 },
			{ id: 'p5b-editable', focus: 'p5b-editable', folded: 0 },
		]);
		expect(fieldKeys).toEqual([left, left, left]);
		expect(selectedBefore).toBeGreaterThan(20);
		expect(withSelection).toEqual({ keys: [left], folded: 0, selectionKept: true });
		expect(withCaret).toEqual({ keys: ['alt+shift+ArrowDown taken'], folded: 1 });
		expect(errors(h)).toEqual([]);
	});

	test('lane 9: the options page refuses keys that typing, the browser or the system use and stores nothing, the reader rebinds fold there, an open tab and a reloaded one use the new shortcut, the hint and the options page show it, a page cannot change it, and the default comes back', async ({
		h,
	}) => {
		const png = await fresh('p5b-shortcuts');
		const mock = await mockProvider(h);
		await hintSeen(h);
		await h.navigate(koWiki);
		await ready(h);
		await h.page.evaluate(() => {
			const shows = { count: 0 };
			Object.assign(window, { __p5bShows: shows });
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') shows.count++;
			});
		});
		const options = await h.context.newPage();
		await options.goto(optionsUrl(h));
		const shown = () =>
			options.evaluate(() => ({
				fold: document.querySelector('#shortcuts .fold-keys')?.textContent,
				unfold: document.querySelector('#shortcuts .unfold-keys')?.textContent,
				status: document.getElementById('keys-status')?.textContent,
			}));
		const stored = () => worker(h).evaluate(() => chrome.storage.local.get('shortcuts'));
		const before = await shown();
		const change = options.locator('[data-change="fold"]');
		const refusals: { keys: string; fold?: string | null; status?: string | null }[] = [];
		for (const keys of ['Shift+KeyJ', 'Control+KeyF', 'Alt+ArrowLeft', 'Alt+ArrowDown', 'Control+Shift+KeyT', 'Alt+Shift+ArrowUp']) {
			await change.click();
			await options.keyboard.press(keys);
			const { fold, status } = await shown();
			refusals.push({ keys, fold, status });
		}
		await options.waitForTimeout(500);
		const refused = await stored();
		await change.click();
		await options.keyboard.press('Alt+Shift+KeyJ');
		await expect.poll(shown).toMatchObject({ fold: 'Alt+Shift+J', status: 'Fold is now Alt+Shift+J.' });
		const rebound = await shown();
		await options.locator('#keyboard').screenshot({ path: png });
		const saved = await stored();

		await watchKeys(h.page);
		await h.pointAt(nth(wikiParagraphs, 1));
		await h.press('Alt+Shift+ArrowDown');
		const oldKey = { keys: await keysSeen(h.page), folded: await folded(h) };
		await h.press('Alt+Shift+KeyJ');
		const newKey = { keys: await keysSeen(h.page), folded: await folded(h) };
		await h.press('Alt+Shift+ArrowUp');
		const unfolded = await folded(h);
		const shownAgain = await h.page.evaluate(() => (window as unknown as { __p5bShows: { count: number } }).__p5bShows.count);
		await h.inContent(
			`void chrome.runtime.sendMessage({ type: 'set-shortcuts', shortcuts: { fold: { code: 'KeyQ', ctrl: false, alt: true, shift: true, meta: false }, unfold: { code: 'KeyW', ctrl: false, alt: true, shift: true, meta: false } } })`,
		);
		await h.page.waitForTimeout(500);
		const afterPageAsked = await stored();

		await hintSeen(h, false);
		await h.page.reload({ waitUntil: 'load' });
		await ready(h);
		await h.pointAt(nth(wikiParagraphs, 1));
		await expect(h.page.locator('tf-hint')).toHaveCount(1, { timeout: 4000 });
		const hint = await h.page.evaluate(() => document.querySelector('tf-hint')?.shadowRoot?.querySelector('div')?.textContent);
		await h.press('Alt+Shift+KeyJ');
		const afterReload = await folded(h);
		await h.press('Alt+Shift+ArrowUp');

		await options.reload();
		const reopened = await shown();
		await options.locator('#default-keys').click();
		await expect.poll(shown).toMatchObject({ fold: 'Alt+Shift+↓', status: 'The default shortcuts are back.' });
		const reset = { shown: await shown(), stored: await stored() };
		await h.page.bringToFront();
		await h.press('Alt+Shift+KeyJ');
		const oldAfterReset = await folded(h);
		await h.press('Alt+Shift+ArrowDown');
		const defaultAfterReset = await folded(h);
		await mock.close();

		console.log(`options before ${JSON.stringify(before)}`);
		console.log(`refused ${JSON.stringify(refusals)}; stored after them ${JSON.stringify(refused)}`);
		console.log(`Alt+Shift+J ${JSON.stringify(rebound)}; stored ${JSON.stringify(saved)}`);
		console.log(`open tab, shown again ${shownAgain} times: old key ${JSON.stringify(oldKey)}, new key ${JSON.stringify(newKey)}, unfolded to ${unfolded}`);
		console.log(`stored after a page asked to change it ${JSON.stringify(afterPageAsked)}`);
		console.log(`after a reload: hint ${JSON.stringify(hint)}, Alt+Shift+J folded ${afterReload}; options reopened ${JSON.stringify(reopened)}`);
		console.log(`default: ${JSON.stringify(reset)}; then Alt+Shift+J folded ${oldAfterReset}, Alt+Shift+Down folded ${defaultAfterReset}`);
		expect(before).toMatchObject({ fold: 'Alt+Shift+↓', unfold: 'Alt+Shift+↑' });
		const modifiers = "Hold Shift and Ctrl or Alt with the key, so that typing and the browser's own shortcuts keep working.";
		expect(refusals).toEqual([
			{ keys: 'Shift+KeyJ', fold: 'Alt+Shift+↓', status: modifiers },
			{ keys: 'Control+KeyF', fold: 'Alt+Shift+↓', status: modifiers },
			{ keys: 'Alt+ArrowLeft', fold: 'Alt+Shift+↓', status: modifiers },
			{ keys: 'Alt+ArrowDown', fold: 'Alt+Shift+↓', status: modifiers },
			{ keys: 'Control+Shift+KeyT', fold: 'Alt+Shift+↓', status: 'Chrome or your computer already uses Ctrl+Shift+T. Pick another shortcut.' },
			{ keys: 'Alt+Shift+ArrowUp', fold: 'Alt+Shift+↓', status: 'Fold and unfold need different shortcuts.' },
		]);
		expect(refused).toEqual({});
		expect(rebound).toMatchObject({ fold: 'Alt+Shift+J', unfold: 'Alt+Shift+↑', status: 'Fold is now Alt+Shift+J.' });
		expect(saved).toEqual({
			shortcuts: {
				fold: { code: 'KeyJ', ctrl: false, alt: true, shift: true, meta: false },
				unfold: { code: 'ArrowUp', ctrl: false, alt: true, shift: true, meta: false },
			},
		});
		expect(oldKey).toEqual({ keys: ['alt+shift+ArrowDown left to the page'], folded: 0 });
		expect(newKey).toEqual({ keys: ['alt+shift+KeyJ taken'], folded: 1 });
		expect(unfolded).toBe(0);
		expect(shownAgain).toBe(0);
		expect(afterPageAsked).toEqual(saved);
		expect(hint).toContain('Or press Alt+Shift+J, ');
		expect(afterReload).toBe(1);
		expect(reopened).toMatchObject({ fold: 'Alt+Shift+J', unfold: 'Alt+Shift+↑' });
		expect(reset.shown).toMatchObject({ fold: 'Alt+Shift+↓', status: 'The default shortcuts are back.' });
		expect(reset.stored).toEqual({ shortcuts: { fold: { code: 'ArrowDown', ctrl: false, alt: true, shift: true, meta: false }, unfold: { code: 'ArrowUp', ctrl: false, alt: true, shift: true, meta: false } } });
		expect([oldAfterReset, defaultAfterReset]).toEqual([0, 1]);
		expect(errors(h)).toEqual([]);
	});
});

async function presenter(h: Harness) {
	await h.page.setViewportSize({ width: 1280, height: 720 });
	await h.page.addInitScript(() => {
		addEventListener('DOMContentLoaded', () => {
			const dot = document.body.appendChild(document.createElement('div'));
			dot.style.cssText =
				'position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(220,40,40,.55);border:2px solid #fff;pointer-events:none;z-index:2147483647;left:-50px;top:-50px';
			const caption = document.body.appendChild(document.createElement('div'));
			caption.id = 'tf-caption';
			caption.style.cssText =
				'position:fixed;left:16px;bottom:16px;max-width:1000px;padding:8px 14px;border-radius:8px;background:rgba(20,20,20,.85);color:#fff;font:600 18px system-ui;pointer-events:none;z-index:2147483647';
			caption.textContent = sessionStorage.getItem('tf-caption') ?? '';
			addEventListener('mousemove', (event) => {
				dot.style.left = `${event.clientX}px`;
				dot.style.top = `${event.clientY}px`;
			});
		});
	});
	const say = (text: string) =>
		h.page.evaluate((value) => {
			sessionStorage.setItem('tf-caption', value);
			const caption = document.getElementById('tf-caption');
			if (caption) caption.textContent = value;
		}, text);
	const moveTo = async (index: number) => {
		const point = await h.page.evaluate(
			({ selector, index }) => {
				const el = document.querySelectorAll(selector)[index];
				const shown = el?.checkVisibility() ? el : el?.nextElementSibling;
				const box = shown?.getBoundingClientRect();
				if (!box) throw new Error(`paragraph ${index} has no box`);
				return { x: box.left + Math.min(box.width / 2, 260), y: box.top + Math.min(box.height / 2, 30) };
			},
			{ selector: wikiParagraphs, index },
		);
		await h.page.mouse.move(point.x, point.y, { steps: 14 });
		return point;
	};
	const scrollTo = async (index: number) => {
		await h.page.locator(nth(wikiParagraphs, index)).evaluate((el) => el.scrollIntoView({ block: 'start' }));
		await h.page.evaluate(() => scrollBy(0, -140));
		await h.page.waitForTimeout(900);
	};
	const key = async (keys: string, text: string, hold = 1600) => {
		await say(text);
		await h.press(keys);
		await h.page.waitForTimeout(hold);
	};
	return { say, moveTo, scrollTo, key };
}

function sh(command: string, args: string[]): string {
	const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr}`);
	return result.stdout.trim();
}

async function encode(videoDir: string, mp4: string): Promise<void> {
	const [webm] = (await readdir(videoDir)).filter((name) => name.endsWith('.webm'));
	if (!webm) throw new Error('Playwright wrote no video');
	sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(videoDir, webm), '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
	const { size } = await stat(mp4);
	const seconds = Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]));
	console.log(`${path.basename(mp4)}: ${(size / 1e6).toFixed(2)} MB, ${seconds.toFixed(1)} s`);
	expect(size).toBeLessThan(5e6);
	expect(seconds).toBeGreaterThanOrEqual(30);
	expect(seconds).toBeLessThanOrEqual(60);
}

test.describe('video probe', () => {
	test.skip(process.env.TFOLD_PROBE !== 'video', 'TFOLD_PROBE=video records the review video');

	test('first-run hint, keyboard folding, the site switch and a failure badge on Korean Wikipedia', async ({ headless }) => {
		test.setTimeout(240_000);
		const videoDir = path.join(outDir, 'video');
		const mp4 = path.join(outDir, 'p5b-review.mp4');
		await rm(videoDir, { recursive: true, force: true });
		await rm(mp4, { force: true });
		const h = await launch({ headless, allowLiveHosts: ['127.0.0.1'], recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
		try {
			const mock = await mockProvider(h, [{ delayMs: 1400 }, 'error', { delayMs: 1200 }]);
			const { say, moveTo, scrollTo, key } = await presenter(h);
			await h.navigate(koWiki);
			await scrollTo(1);
			await say('First visit to Korean Wikipedia, 블랙홀, with a mock model: rest the pointer on a paragraph');
			await h.page.waitForTimeout(1500);
			await moveTo(1);
			await expect(h.page.locator('tf-hint')).toHaveCount(1, { timeout: 4000 });
			await say('A one-time hint in the page language, next to the paragraph and never on it; nothing on the page moves');
			await h.page.waitForTimeout(3500);
			await key('Alt+Shift+ArrowDown', 'Alt+Shift+↓ (Option+Shift+↓ on a Mac) folds the paragraph under the pointer. The rail means the model is writing', 2600);
			await key('Alt+Shift+ArrowDown', 'Alt+Shift+↓ again: Key, written by the model', 1800);
			await key('Alt+Shift+ArrowDown', 'Alt+Shift+↓ again: Takeaway', 1800);
			await key('Alt+Shift+ArrowDown', 'No level is left, so another press stays with the page and changes nothing', 1800);
			await key('Alt+Shift+ArrowUp', 'Alt+Shift+↑ steps back: Key', 1200);
			await key('Alt+Shift+ArrowUp', 'Brief', 1200);
			await key('Alt+Shift+ArrowUp', 'Full', 1400);
			await moveTo(3);
			await key('Alt+Shift+ArrowDown', 'Fold another paragraph', 1600);
			await switchSite(h);
			await h.page.waitForTimeout(300);
			await say(`The switch in the toolbar popup is off: tfold is off for this site, every fold is back to Full, and the icon's badge reads "${await badge(h)}"`);
			await h.page.waitForTimeout(2600);
			await key('Alt+Shift+ArrowDown', 'Off: the shortcut and fold do nothing on this site, and it stays off after a reload', 2400);
			await switchSite(h);
			await h.page.waitForTimeout(300);
			await say(`Switched on again: tfold is back on for this site, and the badge is ${(await badge(h)) === '' ? 'gone' : 'still there'}`);
			await h.page.waitForTimeout(1600);
			await key('Alt+Shift+ArrowDown', 'On again: the same paragraph folds', 2000);
			await scrollTo(otherSection);
			await moveTo(otherSection);
			await key('Alt+Shift+ArrowDown', 'Another section, and the mock model fails this time', 2600);
			await say('The badge says what happened in Korean, and that folding again retries');
			await h.page.waitForTimeout(3000);
			await key('Alt+Shift+ArrowDown', 'Fold again: the rail while it retries, then the model fold', 3200);
			await say('tfold: discoverable, keyboard-friendly, and switchable per site. The options page can change the shortcut');
			await h.page.waitForTimeout(2000);
			await mock.close();
			expect(mock.prompts).toHaveLength(3);
		} finally {
			await h.close();
		}
		await encode(videoDir, mp4);
	});
});
