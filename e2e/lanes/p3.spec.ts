import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { localFold } from '../../src/fold/local.ts';
import type { FoldRequest } from '../../src/fold/prompt.ts';
import type { FoldResult } from '../../src/fold/providers/index.ts';
import { readCompletion } from '../../src/fold/providers/openai-compatible.ts';
import { presets } from '../../src/fold/providers/presets.ts';
import { bodies } from '../../src/fold/providers/request-body.ts';
import { failedWaitMs, requestTimeoutMs } from '../../src/messages.ts';
import { fixtures, launch, type Harness } from '../harness.ts';
import { expect, test } from '../lane.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p3');
const usageLog = path.join(outDir, 'usage.jsonl');
const latchMs = 400;
const modelWaitMs = 30_000;
const wikiParagraphs = '#mw-content-text section > p:not(.mw-empty-elt):not([data-tfold-overlay])';
const koWiki = '/wikipedia-ko-black-hole/';
const placeholder = process.env.OPENROUTER_API_KEY ?? '';

const nth = (selector: string, index: number) => `${selector} >> nth=${index}`;

type Overlay = { level: string | null; fold: string | null; badge: string | null; text: string | null; hidden: boolean };
type Usage = { promptTokens: number; completionTokens: number; cost?: number; upstream?: string; blocks: number; ms: number };

async function fresh(slug: string): Promise<string> {
	const file = path.join(outDir, `${slug}.png`);
	await mkdir(outDir, { recursive: true });
	await rm(file, { force: true });
	return file;
}

function sh(command: string, args: string[], cwd = repoRoot): string {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr}`);
	return result.stdout.trim();
}

const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const workerLines = (h: Harness, prefix: string) =>
	h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith(prefix)).map((entry) => entry.text);
const usages = (h: Harness): Usage[] => workerLines(h, 'fold usage ').map((line) => JSON.parse(line.slice('fold usage '.length)) as Usage);

async function logUsage(h: Harness, lane: string): Promise<void> {
	const calls = usages(h);
	await mkdir(outDir, { recursive: true });
	for (const usage of calls) await appendFile(usageLog, `${JSON.stringify({ lane, ...usage })}\n`);
	const cost = calls.reduce((sum, usage) => sum + (usage.cost ?? 0), 0);
	console.log(`${lane}: ${calls.length} OpenRouter calls, $${cost.toFixed(6)}`);
}

function overlay(page: Page, selector: string, index: number): Promise<Overlay> {
	return page.evaluate(
		({ selector, index }) => {
			const el = document.querySelectorAll(selector)[index];
			if (!el) throw new Error(`no element ${index} for ${selector}`);
			const next = el.nextElementSibling;
			const shown = next?.matches('[data-tfold-overlay]') ? next : null;
			const copy = shown?.cloneNode(true) as Element | undefined;
			for (const skip of copy?.querySelectorAll('script, style, annotation, annotation-xml') ?? []) skip.remove();
			for (const sup of copy?.querySelectorAll('sup') ?? []) if (/^\[[^\]]*\]$/.test((sup.textContent ?? '').trim())) sup.remove();
			return {
				level: shown?.getAttribute('data-tf-level') ?? null,
				fold: shown?.getAttribute('data-tf-fold') ?? null,
				badge: shown?.getAttribute('data-tf-badge') ?? null,
				text: copy ? (copy.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
				hidden: !el.checkVisibility(),
			};
		},
		{ selector, index },
	);
}

async function foldBy(h: Harness, selector: string, index: number, steps: number): Promise<void> {
	const point = await h.pointAt(nth(selector, index));
	await h.foldAt(point.x, point.y, steps);
}

async function settled(h: Harness, selector: string, index: number, want: (shown: Overlay) => boolean): Promise<Overlay> {
	await expect.poll(async () => want(await overlay(h.page, selector, index)), { timeout: modelWaitMs }).toBe(true);
	return overlay(h.page, selector, index);
}

const modelFold = (shown: Overlay) => shown.fold === 'model';
const badged = (shown: Overlay) => shown.badge !== null;

function textOfOriginal(page: Page, selector: string, index: number): Promise<string> {
	return page.evaluate(
		({ selector, index }) => {
			const el = document.querySelectorAll(selector)[index]?.cloneNode(true) as Element | undefined;
			if (!el) throw new Error(`no element ${index} for ${selector}`);
			for (const skip of el.querySelectorAll('script, style, annotation, annotation-xml')) skip.remove();
			for (const sup of el.querySelectorAll('sup')) if (/^\[[^\]]*\]$/.test((sup.textContent ?? '').trim())) sup.remove();
			return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
		},
		{ selector, index },
	);
}

const optionsUrl = (h: Harness) => `chrome-extension://${h.extensionId}/options/options.html`;

async function saveKey(h: Harness, key: string): Promise<void> {
	await h.navigate(optionsUrl(h));
	await h.page.locator('#advanced > summary').click();
	await h.page.locator('#use-other').click();
	await expect(h.page.locator('#key-label')).toHaveText('OpenRouter API key');
	await h.page.locator('#key').fill(key);
	await h.page.locator('button[type="submit"]').click();
	await expect(h.page.locator('#status')).toHaveText('The OpenRouter key works and is saved.');
	await expect(h.page.locator('#key-state')).toHaveText('A key is saved. Type a new one to replace it.');
}

const seedKey = (h: Harness, apiKey: string) => h.worker.evaluate((apiKey) => chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter: { apiKey } } }), apiKey);

async function setProvider(h: Harness, provider: Record<string, string>): Promise<void> {
	await h.worker.evaluate((value) => chrome.storage.local.set({ provider: value }), provider);
}

async function sideBySide(page: Page, file: string, shots: { label: string; png: Buffer }[]): Promise<void> {
	const figures = shots
		.map(({ label, png }) => `<figure><figcaption>${label}</figcaption><img src="data:image/png;base64,${png.toString('base64')}"></figure>`)
		.join('');
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.setContent(
		`<style>body{margin:0;background:#444;font:600 18px system-ui;color:#fff}figure{margin:0 0 8px}figcaption{padding:6px 10px}img{display:block;max-width:1280px}</style>${figures}`,
	);
	await page.locator('body').screenshot({ path: file });
}

async function paragraphShot(page: Page, selector: string, index: number): Promise<Buffer> {
	const box = await page.evaluate(
		({ selector, index }) => {
			const el = document.querySelectorAll(selector)[index];
			const shown = el?.nextElementSibling?.matches('[data-tfold-overlay]') ? el.nextElementSibling : el;
			const prev = el?.previousElementSibling;
			shown?.scrollIntoView({ block: 'center' });
			const top = Math.min(prev?.getBoundingClientRect().top ?? Infinity, shown?.getBoundingClientRect().top ?? 0);
			const rect = shown?.getBoundingClientRect();
			return { y: Math.max(0, top - 24), height: (rect?.bottom ?? 0) - Math.max(0, top - 24) + 140 };
		},
		{ selector, index },
	);
	return page.screenshot({ clip: { x: 0, y: box.y, width: page.viewportSize()?.width ?? 1280, height: Math.min(box.height, 700) } });
}

test.describe('live lanes', () => {
	test.use({ allowLiveHosts: ['openrouter.ai'] });
	test.skip(placeholder === '', 'OPENROUTER_API_KEY is not set');

	test('lane 1: with a key set, a fold shows the local Key and then the model-written Key for the same paragraph', async ({ h }) => {
		test.setTimeout(120_000);
		const png = await fresh('p3-model-key');
		await saveKey(h, placeholder);
		await h.navigate(fixtures.wiki);
		const original = await textOfOriginal(h.page, wikiParagraphs, 1);
		await foldBy(h, wikiParagraphs, 1, 2);
		const local = await overlay(h.page, wikiParagraphs, 1);
		const model = await settled(h, wikiParagraphs, 1, modelFold);
		const shot = await paragraphShot(h.page, wikiParagraphs, 1);
		await logUsage(h, 'lane 1');
		await sideBySide(h.page, png, [{ label: 'key set: the model-written Key line', png: shot }]);
		console.log(`model Key: ${model.text}`);
		expect(local).toMatchObject({ level: '2', fold: 'local', text: localFold(original).key });
		expect(model).toMatchObject({ level: '2', fold: 'model', badge: null });
		expect(model.text).not.toBe(localFold(original).key);
		expect(workerLines(h, 'fold request')).toHaveLength(1);
		expect(errors(h)).toEqual([]);
	});

	test('lane 2: a second paragraph in the same section folds from the first call', async ({ h }) => {
		const png = await fresh('p3-same-section');
		await saveKey(h, placeholder);
		await h.navigate(fixtures.wiki);
		await foldBy(h, wikiParagraphs, 1, 2);
		await settled(h, wikiParagraphs, 1, modelFold);
		await h.page.waitForTimeout(latchMs + 100);
		await foldBy(h, wikiParagraphs, 2, 2);
		const second = await overlay(h.page, wikiParagraphs, 2);
		await h.page.waitForTimeout(2000);
		await h.page.locator(nth(wikiParagraphs, 1)).evaluate((el) => el.previousElementSibling?.scrollIntoView({ block: 'start' }));
		await h.page.screenshot({ path: png });
		await logUsage(h, 'lane 2');
		console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
		expect(second).toMatchObject({ level: '2', fold: 'model', badge: null });
		expect(workerLines(h, 'fold request')).toHaveLength(1);
		expect(workerLines(h, 'fold cache hit')).toHaveLength(0);
	});

	test('lane 3: after a reload the same paragraph folds from the cache with no request', async ({ h }) => {
		const png = await fresh('p3-cache');
		await saveKey(h, placeholder);
		await h.navigate(fixtures.wiki);
		await foldBy(h, wikiParagraphs, 1, 2);
		const first = await settled(h, wikiParagraphs, 1, modelFold);
		await h.page.reload({ waitUntil: 'load' });
		expect(await h.page.locator('[data-tfold-overlay]').count()).toBe(0);
		await foldBy(h, wikiParagraphs, 1, 2);
		const again = await settled(h, wikiParagraphs, 1, modelFold);
		await h.page.screenshot({ path: png });
		await logUsage(h, 'lane 3');
		console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
		expect(again.text).toBe(first.text);
		expect(workerLines(h, 'fold request')).toHaveLength(1);
		expect(workerLines(h, 'fold cache hit')).toHaveLength(1);
	});

	test('lane 5: a refused key shows the refused badge over the local fold, and the page keeps working', async ({ h }) => {
		const png = await fresh('p3-bad-key');
		await seedKey(h, 'sk-or-v1-0000000000000000000000000000000000000000000000000000000000000000');
		await h.navigate(fixtures.wiki);
		const original = await textOfOriginal(h.page, wikiParagraphs, 1);
		await foldBy(h, wikiParagraphs, 1, 1);
		const refused = await settled(h, wikiParagraphs, 1, badged);
		const shot = await paragraphShot(h.page, wikiParagraphs, 1);
		await h.page.waitForTimeout(latchMs + 100);
		await foldBy(h, '[data-tfold-overlay]', 0, -1);
		const unfolded = await overlay(h.page, wikiParagraphs, 1);
		await h.page.waitForTimeout(latchMs + 100);
		await foldBy(h, wikiParagraphs, 3, 3);
		const another = await settled(h, wikiParagraphs, 3, badged);
		await sideBySide(h.page, png, [{ label: 'an invalid key: the local Brief with the refused badge', png: shot }]);
		console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
		expect(refused).toMatchObject({ level: '1', fold: 'local', badge: 'Your key was refused · check it in tfold settings', text: localFold(original).sentences[0] });
		expect(unfolded).toMatchObject({ level: null, hidden: false });
		expect(another).toMatchObject({ level: '3', fold: 'local', badge: 'Your key was refused · check it in tfold settings' });
		expect(workerLines(h, 'fold failed, refused, HTTP 401'), 'the second paragraph asks nothing of a key already refused').toHaveLength(1);
		expect(errors(h)).toEqual([]);
	});

	test('lane 7: the key appears nowhere outside the service worker storage', async ({ h }) => {
		const png = await fresh('p3-key-scope');
		await saveKey(h, placeholder);
		const optionsDom = await h.page.evaluate(
			(key) =>
				document.documentElement.outerHTML.includes(key) ||
				[...document.querySelectorAll('input')].some((input) => input.value.includes(key)),
			placeholder,
		);
		await h.navigate(fixtures.wiki);
		await foldBy(h, wikiParagraphs, 1, 2);
		await settled(h, wikiParagraphs, 1, modelFold);
		await logUsage(h, 'lane 7');
		const mainWorld = await h.page.evaluate((key) => {
			const strings: string[] = [];
			for (const name of Object.getOwnPropertyNames(globalThis)) {
				try {
					const value: unknown = (globalThis as Record<string, unknown>)[name];
					if (typeof value === 'string') strings.push(value);
					else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) strings.push(JSON.stringify(value));
				} catch {
					strings.push('');
				}
			}
			const storage = (area: Storage) => Object.keys(area).map((name) => `${name}=${area.getItem(name) ?? ''}`).join('\n');
			return {
				'page DOM': document.documentElement.outerHTML.includes(key),
				'page globals': strings.some((text) => text.includes(key)),
				'page localStorage and sessionStorage': (storage(localStorage) + storage(sessionStorage)).includes(key),
				'page cookies and window.name': (document.cookie + window.name).includes(key),
				'chrome.storage in the page': typeof (globalThis as { chrome?: { storage?: unknown } }).chrome?.storage !== 'undefined',
			};
		}, placeholder);
		await h.inContent(`void (async () => {
			const key = ${JSON.stringify(placeholder)};
			const strings = [];
			for (const name of Object.getOwnPropertyNames(globalThis)) {
				try {
					const value = globalThis[name];
					if (typeof value === 'string') strings.push(value);
					else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) strings.push(JSON.stringify(value));
				} catch {}
			}
			const read = async (area) => {
				try {
					return JSON.stringify(await chrome.storage[area].get(null)).includes(key);
				} catch (error) {
					return 'denied: ' + String(error.message ?? error).slice(0, 80);
				}
			};
			globalThis.laneSevenSearch = {
				'content script globals': strings.some((text) => text.includes(key)),
				'content script chrome.storage.local': await read('local'),
				'content script chrome.storage.session': await read('session'),
			};
		})()`);
		await expect.poll(() => h.inContent<boolean>('globalThis.laneSevenSearch !== undefined')).toBe(true);
		const contentWorld = await h.inContent<Record<string, boolean | string>>('globalThis.laneSevenSearch');
		const worker = await h.worker.evaluate(async (key) => JSON.stringify(await chrome.storage.local.get(null)).includes(key), placeholder);
		const found: Record<string, boolean | string> = { 'options page DOM after save': optionsDom, ...mainWorld, ...contentWorld };
		const report = Object.entries(found)
			.map(([where, value]) => `${where}: ${value === true ? 'FOUND' : value === false ? 'not found' : value}`)
			.concat(`service worker chrome.storage.local, the positive control: ${worker ? 'FOUND' : 'not found'}`)
			.join('\n');
		console.log(report);
		await h.showText('Where the key placeholder appears, searched after a live fold', report);
		await h.page.screenshot({ path: png });
		expect(worker).toBe(true);
		expect(Object.entries(found).filter(([, value]) => value === true).map(([where]) => where)).toEqual([]);
		expect(found['content script chrome.storage.session']).toMatch(/^denied/);
		expect(found['content script chrome.storage.local']).toMatch(/^denied/);
	});

	test('lane 8: an arXiv paragraph at Brief shows only verbatim sentences of the original', async ({ h }) => {
		const png = await fresh('p3-arxiv');
		const paragraphs = '.ltx_para > p.ltx_p:not([data-tfold-overlay])';
		await saveKey(h, placeholder);
		await h.navigate(fixtures.arxiv);
		const index = await h.page.evaluate((selector) => {
			const all = [...document.querySelectorAll(selector)];
			return all.findIndex((p) => !p.querySelector('math, sup, cite, .ltx_note') && (p.textContent ?? '').split(/(?<=\.)\s+(?=[A-Z])/).length >= 3);
		}, paragraphs);
		expect(index).toBeGreaterThanOrEqual(0);
		const original = await textOfOriginal(h.page, paragraphs, index);
		const fullShot = await paragraphShot(h.page, paragraphs, index);
		await foldBy(h, paragraphs, index, 1);
		const brief = await settled(h, paragraphs, index, modelFold);
		await sideBySide(h.page, png, [
			{ label: 'arXiv 2401.04088, a paragraph at Full', png: fullShot },
			{ label: 'the same paragraph at Brief: sentences the model picked, verbatim', png: await paragraphShot(h.page, paragraphs, index) },
		]);
		await logUsage(h, 'lane 8');
		const sentences = localFold(original).sentences;
		let rest = brief.text ?? '';
		const kept: number[] = [];
		for (const [i, sentence] of sentences.entries()) {
			if (rest === sentence || rest.startsWith(`${sentence} `)) {
				kept.push(i);
				rest = rest.slice(sentence.length).trimStart();
			}
		}
		console.log(`paragraph ${index} has ${sentences.length} sentences; the model kept ${JSON.stringify(kept)}`);
		console.log(`Brief: ${brief.text}`);
		expect(brief).toMatchObject({ level: '1', fold: 'model', badge: null });
		expect(kept.length).toBeGreaterThan(0);
		expect(rest).toBe('');
		for (const i of kept) expect(original.includes(sentences[i] ?? '\u0000')).toBe(true);
	});

	test('lane 9: a Korean paragraph gets a Key line written in Korean', async ({ h }) => {
		const png = await fresh('p3-korean');
		const paragraphs = wikiParagraphs;
		await saveKey(h, placeholder);
		await h.navigate(koWiki);
		await foldBy(h, paragraphs, 1, 2);
		const key = await settled(h, paragraphs, 1, (shown) => modelFold(shown) || badged(shown));
		console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
		const original = await textOfOriginal(h.page, paragraphs, 1);
		const shot = await paragraphShot(h.page, paragraphs, 1);
		await logUsage(h, 'lane 9');
		const letters = [...(key.text ?? '')].filter((c) => /\p{L}/u.test(c));
		const hangul = letters.filter((c) => /\p{Script=Hangul}/u.test(c)).length / Math.max(1, letters.length);
		console.log(`Key: ${key.text}`);
		console.log(`Hangul share of the Key line's letters: ${hangul.toFixed(2)}`);
		await sideBySide(h.page, png, [{ label: 'ko.wikipedia.org 블랙홀, the second paragraph at Key: the model wrote it in Korean', png: shot }]);
		expect(key).toMatchObject({ level: '2', fold: 'model', badge: null });
		expect(key.text).not.toBe(localFold(original).key);
		expect(hangul).toBeGreaterThan(0.6);
	});
});

test('lane 4: with the key removed, a fold shows the local fold and the missing key badge', async ({ h }) => {
	const png = await fresh('p3-no-key');
	await seedKey(h, 'sk-or-v1-lane-4-key-that-is-removed-before-any-request');
	await h.navigate(optionsUrl(h));
	await h.page.locator('#remove-key').click();
	await expect(h.page.locator('#status')).toHaveText('The OpenRouter key is removed.');
	const optionsShot = await h.page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 520 } });
	await h.navigate(fixtures.wiki);
	const original = await textOfOriginal(h.page, wikiParagraphs, 1);
	await foldBy(h, wikiParagraphs, 1, 1);
	const shown = await settled(h, wikiParagraphs, 1, badged);
	const pageShot = await paragraphShot(h.page, wikiParagraphs, 1);
	await sideBySide(h.page, png, [
		{ label: 'options: Remove key clicked', png: optionsShot },
		{ label: 'a how: the local Brief with the missing key badge', png: pageShot },
	]);
	console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
	expect(shown).toMatchObject({ level: '1', fold: 'local', badge: 'Add a key in tfold settings to get AI summaries', text: localFold(original).sentences[0] });
	expect(workerLines(h, 'fold skipped, no API key')).toHaveLength(1);
	expect(workerLines(h, 'fold request')).toHaveLength(0);
});

type MockBody = {
	messages: { content: string }[];
	response_format?: { json_schema?: { strict?: boolean } };
	reasoning?: unknown;
};

type MockReply = string | { hold: 'headers' | 'body' };

async function mockProvider(h: Harness, answer: (prompt: string, call: number) => MockReply) {
	const bodies: MockBody[] = [];
	const server = http.createServer((request, response) => {
		const cors = {
			'access-control-allow-origin': '*',
			'access-control-allow-headers': 'authorization, content-type',
			'access-control-allow-methods': 'POST',
		};
		if (request.method === 'OPTIONS') {
			response.writeHead(204, cors).end();
			return;
		}
		let raw = '';
		request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		request.on('end', () => {
			const body = JSON.parse(raw) as MockBody;
			bodies.push(body);
			const content = answer(body.messages.at(-1)?.content ?? '', bodies.length);
			if (typeof content !== 'string') {
				if (content.hold === 'body') response.writeHead(200, { ...cors, 'content-type': 'application/json' }).flushHeaders();
				return;
			}
			response.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(
				JSON.stringify({
					id: 'gen-mock',
					choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
					usage: { prompt_tokens: 0, completion_tokens: 0 },
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	await setProvider(h, { kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'mock-key', model: 'mock/model' });
	return {
		bodies,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

const mockFold = (prompt: string, call: number) =>
	JSON.stringify({
		units: [...prompt.matchAll(/^\[U(\d+)\]/gm)].map(([, n]) => ({ id: `U${n}`, takeaway: `Mock fold ${call}`, reason: '', evidence: [0] })),
	});

test.describe('mock server', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	test('lane 6: an empty content keeps the local fold and shows the failure badge', async ({ h }) => {
		const png = await fresh('p3-empty');
		const mock = await mockProvider(h, () => '');
		try {
			await h.navigate(fixtures.wiki);
			const original = await textOfOriginal(h.page, wikiParagraphs, 1);
			await foldBy(h, wikiParagraphs, 1, 1);
			const shown = await settled(h, wikiParagraphs, 1, badged);
			await sideBySide(h.page, png, [
				{ label: 'a mock provider that answers with an empty content: the local Brief and the failure badge', png: await paragraphShot(h.page, wikiParagraphs, 1) },
			]);
			console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
			expect(mock.bodies).toHaveLength(1);
			expect(mock.bodies[0]?.response_format?.json_schema?.strict).toBe(true);
			expect(mock.bodies[0]?.reasoning).toEqual({ enabled: false });
			expect(shown).toMatchObject({ level: '1', fold: 'local', badge: 'AI summary failed · try again', text: localFold(original).sentences[0] });
			expect(workerLines(h, 'fold failed, failed, empty content')).toHaveLength(1);
		} finally {
			await mock.close();
		}
	});

	test('a page script that dispatches ctrl+wheel events neither folds a paragraph nor sends a request', async ({ h }) => {
		const mock = await mockProvider(h, mockFold);
		try {
			await h.navigate(fixtures.wiki);
			await h.page.locator(nth(wikiParagraphs, 1)).evaluate((el) => {
				const { left, top } = el.getBoundingClientRect();
				for (let i = 0; i < 12; i++) {
					el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 30, bubbles: true, cancelable: true, clientX: left + 10, clientY: top + 10 }));
				}
			});
			await h.page.waitForTimeout(1500);
			expect(await overlay(h.page, wikiParagraphs, 1)).toMatchObject({ level: null, hidden: false });
			expect(mock.bodies).toHaveLength(0);
			await foldBy(h, wikiParagraphs, 1, 1);
			const real = await settled(h, wikiParagraphs, 1, modelFold);
			console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
			expect(real).toMatchObject({ level: '1', fold: 'model' });
			expect(mock.bodies).toHaveLength(1);
		} finally {
			await mock.close();
		}
	});

	test('a paragraph whose text changed after its model fold gets a new model fold on the next fold', async ({ h }) => {
		const mock = await mockProvider(h, mockFold);
		const paragraph = '#counter-paragraph';
		try {
			await h.navigate(fixtures.react);
			await expect(h.page.locator('#counter')).toHaveText('0');
			await foldBy(h, paragraph, 0, 3);
			const first = await settled(h, paragraph, 0, modelFold);
			await h.page.locator('#counter').dispatchEvent('click');
			await expect.poll(async () => (await overlay(h.page, paragraph, 0)).fold).toBe('local');
			await h.page.waitForTimeout(latchMs + 100);
			await foldBy(h, `${paragraph} + [data-tfold-overlay]`, 0, -3);
			await expect(h.page.locator('#counter')).toHaveText('1');
			await h.page.waitForTimeout(latchMs + 100);
			await foldBy(h, paragraph, 0, 3);
			const second = await settled(h, paragraph, 0, (shown) => shown.fold === 'model' && shown.text !== first.text);
			console.log(`Takeaway before the click: ${first.text}; after: ${second.text}`);
			expect(first.text).toContain('Mock fold 1');
			expect(second).toMatchObject({ level: '3', fold: 'model' });
			expect(second.text).toContain('Mock fold 2');
			expect(mock.bodies).toHaveLength(2);
		} finally {
			await mock.close();
		}
	});

	test('a provider that never answers shows the network badge at the timeout, and each later fold retries', async ({ h }) => {
		const replies: MockReply[] = [{ hold: 'headers' }, { hold: 'body' }];
		const mock = await mockProvider(h, (prompt, call) => replies[call - 1] ?? mockFold(prompt, call));
		const untilBadge = async () => {
			const started = Date.now();
			await expect.poll(async () => badged(await overlay(h.page, wikiParagraphs, 1)), { timeout: requestTimeoutMs + 5000, intervals: [100] }).toBe(true);
			return { waited: Date.now() - started, shown: await overlay(h.page, wikiParagraphs, 1) };
		};
		const foldAgain = async () => {
			await h.page.waitForTimeout(failedWaitMs + 100);
			await foldBy(h, `${wikiParagraphs} + [data-tfold-overlay]`, 0, 1);
			return overlay(h.page, wikiParagraphs, 1);
		};
		try {
			await h.navigate(fixtures.wiki);
			const original = await textOfOriginal(h.page, wikiParagraphs, 1);
			await foldBy(h, wikiParagraphs, 1, 1);
			const local = await overlay(h.page, wikiParagraphs, 1);
			const silent = await untilBadge();
			const firstRetry = await foldAgain();
			const stalled = await untilBadge();
			await foldAgain();
			const answered = await settled(h, wikiParagraphs, 1, modelFold);
			console.log(`the badge showed ${silent.waited} ms after a request with no answer and ${stalled.waited} ms after one with headers and no body`);
			console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
			expect(local).toMatchObject({ level: '1', fold: 'local', badge: null, text: localFold(original).sentences[0] });
			for (const { waited } of [silent, stalled]) {
				expect(waited).toBeGreaterThan(requestTimeoutMs - 1000);
				expect(waited).toBeLessThan(requestTimeoutMs + 2000);
			}
			expect(silent.shown).toMatchObject({ level: '1', fold: 'local', badge: 'Network error · try again', text: localFold(original).sentences[0] });
			expect(firstRetry).toMatchObject({ level: '2', fold: 'local', badge: null });
			expect(stalled.shown).toMatchObject({ level: '2', fold: 'local', badge: 'Network error · try again', text: localFold(original).key });
			expect(workerLines(h, 'fold failed, network, timed out before the response headers')).toHaveLength(1);
			expect(workerLines(h, 'fold failed, network, timed out reading the response body')).toHaveLength(1);
			expect(workerLines(h, 'fold cache hit')).toHaveLength(0);
			expect(mock.bodies).toHaveLength(3);
			expect(answered).toMatchObject({ level: '3', fold: 'model', badge: null });
			expect(answered.text).toContain('Mock fold 3');
		} finally {
			await mock.close();
		}
	});

	test('a fold over a reference entry folds nothing and sends no request', async ({ h }) => {
		const mock = await mockProvider(h, mockFold);
		const longReference = (page: Page) =>
			page.evaluate(() => {
				const items = [...document.querySelectorAll('ol.references > li')];
				const index = items.findIndex((li) => (li.textContent ?? '').trim().split(/\s+/).length >= 25);
				items[index]?.setAttribute('id', 'long-reference');
				return index;
			});
		try {
			for (const fixture of [fixtures.wiki, koWiki]) {
				await h.navigate(fixture);
				expect(await longReference(h.page)).toBeGreaterThanOrEqual(0);
				await foldBy(h, '#long-reference', 0, 1);
				await h.page.waitForTimeout(1500);
				expect(await h.page.locator('[data-tfold-overlay]').count()).toBe(0);
			}
			console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
			expect(mock.bodies).toHaveLength(0);
			expect(workerLines(h, 'fold ')).toEqual([]);
		} finally {
			await mock.close();
		}
	});

	test('Brief keeps fewer sentences than Full for a 3-sentence paragraph, even when the model picks all three', async ({ h }) => {
		const allSentences = (prompt: string) =>
			JSON.stringify({
				units: prompt
					.split(/^\[U\d+\]/m)
					.slice(1)
					.map((unit, n) => ({ id: `U${n}`, takeaway: 'Mock takeaway', reason: '', evidence: [...unit.matchAll(/^ {2}(\d+): /gm)].map(([, i]) => Number(i)) })),
			});
		const mock = await mockProvider(h, allSentences);
		try {
			await h.navigate(fixtures.wiki);
			let index = -1;
			let sentences: string[] = [];
			while (sentences.length !== 3) sentences = localFold(await textOfOriginal(h.page, wikiParagraphs, ++index)).sentences;
			await foldBy(h, wikiParagraphs, index, 1);
			const brief = await settled(h, wikiParagraphs, index, modelFold);
			const evidence = (JSON.parse(allSentences(mock.bodies[0]?.messages.at(-1)?.content ?? '')) as { units: { evidence: number[] }[] }).units;
			console.log(`paragraph ${index}, the model picked ${JSON.stringify(evidence.map((unit) => unit.evidence))}, Brief: ${brief.text}`);
			expect(evidence.some((unit) => unit.evidence.length === 3)).toBe(true);
			expect(brief).toMatchObject({ level: '1', fold: 'model', text: sentences.slice(0, 2).join(' ') });
		} finally {
			await mock.close();
		}
	});
});

test('lane 10: offline, an uncached section keeps the local fold and shows the network badge', async ({ h }) => {
	const png = await fresh('p3-offline');
	await seedKey(h, 'sk-or-v1-lane-10-the-network-is-offline-before-any-request');
	await h.navigate(fixtures.wiki);
	const original = await textOfOriginal(h.page, wikiParagraphs, 6);
	console.log('setOffline does not reach the extension service worker, so its requests fail as internetdisconnected');
	const disconnected: string[] = [];
	await h.context.route(
		(url) => url.protocol === 'https:',
		(route) => {
			disconnected.push(route.request().url());
			return route.abort('internetdisconnected');
		},
	);
	await h.context.setOffline(true);
	await foldBy(h, wikiParagraphs, 6, 1);
	const shown = await settled(h, wikiParagraphs, 6, badged);
	await sideBySide(h.page, png, [
		{ label: 'the browser offline: the local Brief with the network badge', png: await paragraphShot(h.page, wikiParagraphs, 6) },
	]);
	console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
	expect(disconnected).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
	expect(shown).toMatchObject({ level: '1', fold: 'local', badge: 'Network error · try again', text: localFold(original).sentences[0] });
	expect(workerLines(h, 'fold failed, network')).toHaveLength(1);
});

type Stamps = {
	el: Element | null;
	first: number;
	step: number;
	modelSeen: boolean;
	model: number;
	badgeSeen: boolean;
	badge: number;
};
type Timing = { fromStep: number; fromFirst: number };

const unstamped = { first: 0, step: 0, modelSeen: false, model: 0, badgeSeen: false, badge: 0 };

async function installStamps(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const stamps: Stamps = { el: null, first: 0, step: 0, modelSeen: false, model: 0, badgeSeen: false, badge: 0 };
		Object.assign(globalThis, { stamps });
		addEventListener(
			'wheel',
			(event) => {
				if (!event.ctrlKey) return;
				stamps.first ||= event.timeStamp;
				stamps.step = event.timeStamp;
			},
			{ capture: true, passive: true },
		);
		const check = () => {
			const next = stamps.el?.nextElementSibling;
			if (!next?.matches('[data-tfold-overlay]')) return;
			if (!stamps.modelSeen && next.getAttribute('data-tf-fold') === 'model') {
				stamps.modelSeen = true;
				requestAnimationFrame(() => (stamps.model = performance.now()));
			}
			if (!stamps.badgeSeen && next.hasAttribute('data-tf-badge')) {
				stamps.badgeSeen = true;
				requestAnimationFrame(() => (stamps.badge = performance.now()));
			}
		};
		addEventListener('DOMContentLoaded', () =>
			new MutationObserver(check).observe(document.documentElement, {
				subtree: true,
				childList: true,
				attributes: true,
				attributeFilter: ['data-tf-fold', 'data-tfold-hidden', 'data-tf-badge'],
			}),
		);
	});
}

async function timedFold(h: Harness, index: number): Promise<Timing> {
	await h.page.evaluate(
		({ selector, index, unstamped }) => {
			const stamps = (globalThis as unknown as { stamps: Stamps }).stamps;
			Object.assign(stamps, unstamped, { el: document.querySelectorAll(selector)[index] });
		},
		{ selector: wikiParagraphs, index, unstamped },
	);
	await foldBy(h, wikiParagraphs, index, 1);
	await h.page.waitForFunction(
		() => {
			const stamps = (globalThis as unknown as { stamps: Stamps }).stamps;
			return stamps.model > 0 || stamps.badge > 0;
		},
		undefined,
		{ timeout: modelWaitMs },
	);
	const timing = await h.page.evaluate(() => {
		const stamps = (globalThis as unknown as { stamps: Stamps }).stamps;
		if (stamps.model === 0) return { fromStep: Infinity, fromFirst: Infinity };
		return { fromStep: stamps.model - stamps.step, fromFirst: stamps.model - stamps.first };
	});
	await h.page.waitForTimeout(latchMs + 50);
	return timing;
}

function sectionsOf(h: Harness): Promise<number[][]> {
	return h.inContent<number[][]>(`(() => {
		const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(
			(heading) => !heading.closest('nav, footer, figure') && heading.checkVisibility(),
		);
		const sections = new Map();
		for (const [i, p] of [...document.querySelectorAll(${JSON.stringify(wikiParagraphs)})].entries()) {
			if (!globalThis.__tfold.blockAt(p)) continue;
			const heading = headings.findLast((candidate) => candidate.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
			sections.set(heading, [...(sections.get(heading) ?? []), i]);
		}
		return [...sections.values()];
	})()`);
}

const pick = (values: number[], q: number) => values.toSorted((a, b) => a - b)[Math.ceil(q * values.length) - 1] ?? NaN;
const describe = (values: number[]) =>
	`median ${pick(values, 0.5).toFixed(1)} ms, p95 ${pick(values, 0.95).toFixed(1)} ms, range ${Math.min(...values).toFixed(1)} to ${Math.max(...values).toFixed(1)} ms, n ${values.length}`;
const answered = (timing: Timing | undefined) => Number.isFinite(timing?.fromFirst);

test.describe('perf probe', () => {
	test.skip(process.env.TFOLD_PROBE !== 'perf', 'TFOLD_PROBE=perf runs the perf probe');
	test.skip(placeholder === '', 'OPENROUTER_API_KEY is not set');

	test('uncached and cached fold to model fold over every section of the Wikipedia fixture, and tokens per paragraph', async ({
		headless,
	}) => {
		test.setTimeout(1_800_000);
		const h = await launch({ headless, allowLiveHosts: ['openrouter.ai'] });
		try {
			await saveKey(h, placeholder);
			await installStamps(h.page);
			await h.navigate(fixtures.wiki);
			const sections = await sectionsOf(h);
			const uncached: Timing[] = [];
			const cached: Timing[] = [];
			const sameSection: Timing[] = [];
			for (let round = 0; round <= sections.length; round++) {
				const current = sections[round];
				const previous = sections[round - 1];
				await h.page.reload({ waitUntil: 'load' });
				if (previous?.[0] !== undefined && answered(uncached.at(-1))) cached.push(await timedFold(h, previous[0]));
				if (current?.[0] === undefined) continue;
				uncached.push(await timedFold(h, current[0]));
				if (current[1] !== undefined && answered(uncached.at(-1))) sameSection.push(await timedFold(h, current[1]));
			}
			const calls = usages(h);
			const fromStep = (timings: Timing[]) => timings.map((timing) => timing.fromStep);
			const fromFirst = (timings: Timing[]) => timings.map((timing) => timing.fromFirst);
			const blocks = calls.reduce((sum, call) => sum + call.blocks, 0);
			const inputPerParagraph = calls.reduce((sum, call) => sum + call.promptTokens, 0) / blocks;
			const outputPerParagraph = calls.reduce((sum, call) => sum + call.completionTokens, 0) / blocks;
			console.log(`sections ${sections.length}, paragraph indices: ${JSON.stringify(sections)}`);
			console.log('times run from the wheel event that completes the step to the rAF after the fold is in the DOM, as in P2');
			console.log('a section whose model fold never came, the badge showing instead, counts as an infinite time');
			console.log(`uncached section, fold to model fold painted: ${describe(fromStep(uncached))}`);
			console.log(`  from the first wheel event of the fold instead: ${describe(fromFirst(uncached))}`);
			console.log(`  of which the service worker waited on OpenRouter: ${describe(calls.map((call) => call.ms))}`);
			console.log(`  sections with the badge instead of a model fold: ${uncached.filter((timing) => !answered(timing)).length}`);
			console.log(`cached section after a reload, fold to model fold painted: ${describe(fromStep(cached))}`);
			console.log(`  from the first wheel event of the fold instead: ${describe(fromFirst(cached))}`);
			console.log(`a second paragraph of a folded section, fold to model fold painted: ${describe(fromStep(sameSection))}`);
			console.log(`calls ${calls.length}, paragraphs ${blocks}, mean per paragraph: ${inputPerParagraph.toFixed(0)} input and ${outputPerParagraph.toFixed(0)} output tokens`);
			console.log(`per call, blocks, output tokens, ms and upstream: ${calls.map((call) => `${call.blocks} ${call.completionTokens}t ${call.ms}ms ${call.upstream ?? '?'}`).join(' | ')}`);
			expect(sections.length).toBeGreaterThanOrEqual(30);
			expect(workerLines(h, 'fold request')).toHaveLength(sections.length);
			expect(calls).toHaveLength(uncached.filter(answered).length);
			expect(workerLines(h, 'fold cache hit')).toHaveLength(cached.length);
			expect(pick(fromFirst(uncached), 0.95)).toBeLessThanOrEqual(6000);
			expect(pick(fromStep(cached), 0.95)).toBeLessThanOrEqual(50);
			expect(inputPerParagraph).toBeLessThanOrEqual(700);
			expect(outputPerParagraph).toBeLessThanOrEqual(150);
		} finally {
			await logUsage(h, 'perf probe');
			console.log(
				`service worker: ${workerLines(h, 'fold request').length} requests, ${usages(h).length} answered, failures ${JSON.stringify(workerLines(h, 'fold failed'))}`,
			);
			await h.close();
		}
	});
});

const routings = {
	default: {},
	latency: { sort: 'latency' },
	'max-latency': { preferred_max_latency: { p90: 2 } },
} as const;
type Arm = keyof typeof routings;
type Routed = {
	pass: number;
	arm: Arm;
	fixture: string;
	section: number;
	blocks: number;
	status: number;
	headersMs: number;
	ms: number;
	upstream: string;
	cost: number;
	cachedTokens: number;
	completionTokens: number;
	ok: boolean;
	detail: string;
};

const routingLog = path.join(outDir, 'routing.jsonl');

function readRouted(request: FoldRequest, text: string): { result: FoldResult; upstream: string; cost: number; cachedTokens: number } {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return { result: { ok: false, error: 'failed', detail: text.slice(0, 120), busy: false }, upstream: '-', cost: 0, cachedTokens: 0 };
	}
	const { provider, usage } = body as { provider?: string; usage?: { cost?: number; prompt_tokens_details?: { cached_tokens?: number } } };
	return {
		result: readCompletion(request, body),
		upstream: provider ?? '-',
		cost: usage?.cost ?? 0,
		cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
	};
}

test.describe('routing probe', () => {
	test.skip(process.env.TFOLD_PROBE !== 'routing', 'TFOLD_PROBE=routing compares OpenRouter provider routing');
	test.skip(placeholder === '', 'OPENROUTER_API_KEY is not set');
	test.use({ allowLiveHosts: ['openrouter.ai', '127.0.0.1'] });

	test('the default provider routing against another, alternating over every section of two fixtures', async ({ h }) => {
		test.setTimeout(1_800_000);
		const pass = Number(process.env.TFOLD_ROUTING_PASS ?? '0');
		const challenger = (process.env.TFOLD_ROUTING ?? 'latency') as Arm;
		expect(Object.keys(routings)).toContain(challenger);
		const arms: Arm[] = pass % 2 === 0 ? ['default', challenger] : [challenger, 'default'];
		await h.worker.evaluate(() => {
			const seen: unknown[] = [];
			Object.assign(globalThis, { seenRequests: seen });
			chrome.runtime.onMessage.addListener((message: { request?: unknown }) => void seen.push(message.request));
		});
		const mock = await mockProvider(h, mockFold);
		const captured: { fixture: string; section: number; request: FoldRequest }[][] = [];
		try {
			for (const fixture of [fixtures.wiki, koWiki]) {
				await h.navigate(fixture);
				const firsts = (await sectionsOf(h)).map(([first]) => first);
				await h.inContent(`(() => {
					const paragraphs = document.querySelectorAll(${JSON.stringify(wikiParagraphs)});
					for (const i of ${JSON.stringify(firsts)}) globalThis.__tfold.setLevel(globalThis.__tfold.blockAt(paragraphs[i]).id, 1);
				})()`);
				await expect.poll(() => h.page.locator('[data-tfold-overlay][data-tf-fold="model"]').count()).toBe(firsts.length);
				const requests = await h.worker.evaluate(() => (globalThis as unknown as { seenRequests: FoldRequest[] }).seenRequests.splice(0));
				captured.push(requests.map((request, section) => ({ fixture, section, request })));
			}
		} finally {
			await mock.close();
		}
		const [wiki = [], ko = []] = captured;
		const slots = Array.from({ length: Math.max(wiki.length, ko.length) }, (_, i) => [wiki[i], ko[i]]).flat().filter((slot) => slot !== undefined);
		const rows: Routed[] = [];
		const folds: string[] = [];
		await mkdir(outDir, { recursive: true });
		for (const { fixture, section, request } of slots) {
			const arm = arms[section % 2] ?? 'default';
			const body = bodies.openrouter(presets.openrouter.model, request);
			const sent = { ...body, provider: { ...body.provider, ...routings[arm] } };
			const answer = await h.worker.evaluate(
				async ({ sent, key }) => {
					const started = performance.now();
					try {
						const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
							method: 'POST',
							headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
							body: JSON.stringify(sent),
							signal: AbortSignal.timeout(60_000),
						});
						const headersMs = performance.now() - started;
						const text = await response.text();
						return { status: response.status, headersMs, ms: performance.now() - started, text };
					} catch (error) {
						return { status: 0, headersMs: NaN, ms: performance.now() - started, text: String(error) };
					}
				},
				{ sent, key: placeholder },
			);
			const { result, upstream, cost, cachedTokens } = readRouted(request, answer.text);
			const row: Routed = {
				pass,
				arm,
				fixture,
				section,
				blocks: request.blocks.length,
				status: answer.status,
				headersMs: Math.round(answer.headersMs),
				ms: Math.round(answer.ms),
				upstream,
				cost,
				cachedTokens,
				completionTokens: result.ok ? result.usage.completionTokens : 0,
				ok: result.ok,
				detail: result.ok ? '' : `${result.error}, ${result.detail}`,
			};
			rows.push(row);
			await appendFile(routingLog, `${JSON.stringify(row)}\n`);
			if (result.ok && section < 5) folds.push(`${arm} ${fixture} section ${section} via ${row.upstream}: ${result.folds.map((fold) => fold.key).join(' / ')}`);
		}
		const all = (await readFile(routingLog, 'utf8'))
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => JSON.parse(line) as Routed);
		const summary = (label: string, of: Routed[]) => {
			const upstreams = new Map<string, number>();
			for (const row of of) upstreams.set(row.upstream, (upstreams.get(row.upstream) ?? 0) + 1);
			return `${label}: ${describe(of.map((row) => (row.ok ? row.ms : Infinity)))}, failed ${of.filter((row) => !row.ok).length}, $${of.reduce((sum, row) => sum + row.cost, 0).toFixed(5)}, cache hits ${of.filter((row) => row.cachedTokens > 0).length}, upstreams ${[...upstreams].map(([name, n]) => `${name} ${n}`).join(', ')}`;
		};
		console.log(`pass ${pass}: ${slots.length} sections, ${wiki.length} Wikipedia and ${ko.length} Korean, arms alternate by section and swap each pass`);
		for (const arm of arms) {
			const mine = rows.filter((row) => row.arm === arm);
			console.log(summary(`pass ${pass}, ${arm}`, mine));
			for (const fixture of [fixtures.wiki, koWiki]) console.log(summary(`  ${fixture}`, mine.filter((row) => row.fixture === fixture)));
		}
		const passes = new Set(all.map((row) => row.pass)).size;
		for (const arm of arms) console.log(summary(`every row in routing.jsonl, ${passes} passes, ${arm}`, all.filter((row) => row.arm === arm)));
		console.log(`failures: ${JSON.stringify(rows.filter((row) => !row.ok).map((row) => `${row.arm} ${row.fixture} ${row.section} via ${row.upstream}: ${row.detail} after ${row.ms} ms`))}`);
		console.log(`spent $${rows.reduce((sum, row) => sum + row.cost, 0).toFixed(6)} on ${rows.length} calls`);
		console.log(`folds of the first five sections of each fixture:\n${folds.join('\n')}`);
		for (const arm of arms) expect(rows.filter((row) => row.arm === arm).length).toBeGreaterThanOrEqual(30);
	});
});

test.describe('video probe', () => {
	test.skip(process.env.TFOLD_PROBE !== 'video', 'TFOLD_PROBE=video records the review video');
	test.skip(placeholder === '', 'OPENROUTER_API_KEY is not set');

	test('enter the key in options and fold two sections', async ({ headless }) => {
		test.setTimeout(300_000);
		const videoDir = path.join(outDir, 'video');
		const mp4 = path.join(outDir, 'p3-review.mp4');
		await rm(videoDir, { recursive: true, force: true });
		await rm(mp4, { force: true });
		const h = await launch({ headless, allowLiveHosts: ['openrouter.ai'], recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
		try {
			const { say, step, waitForModel, scrollTo } = await presenter(h);
			const moveTo = async (selector: string) => {
				const box = await h.page.locator(selector).first().boundingBox();
				if (!box) throw new Error(`${selector} has no box`);
				await h.page.mouse.move(box.x + Math.min(box.width / 2, 200), box.y + Math.min(box.height / 2, 24), { steps: 12 });
			};

			await h.navigate(optionsUrl(h));
			await h.page.locator('#advanced > summary').click();
			await h.page.locator('#use-other').click();
			await say('tfold settings: paste your own OpenRouter key');
			await h.page.waitForTimeout(2500);
			await moveTo('#key');
			await h.page.locator('#key').click();
			await h.page.locator('#key').pressSequentially(placeholder, { delay: 25 });
			await say('The key field is a password field, so the key stays masked');
			await h.page.waitForTimeout(2000);
			await moveTo('button[type="submit"]');
			await h.page.locator('button[type="submit"]').click();
			await expect(h.page.locator('#status')).toHaveText('The OpenRouter key works and is saved.');
			await say('Checked and saved. The key stays in the extension; pages never see it');
			await h.page.waitForTimeout(2500);

			await h.navigate(fixtures.wiki);
			await scrollTo(1);
			await say('First section: fold over a paragraph');
			await h.page.waitForTimeout(1200);
			await step(1, 2, 'The local Key shows at once, then the model writes the Key line', 200);
			await waitForModel(1);
			await h.page.waitForTimeout(2600);
			await step(2, 2, 'The next paragraph in the section folds with no wait: one call covered the section', 2600);
			await step(1, 1, 'Takeaway: one written headline', 2400);
			await step(1, -2, 'Back to Brief: verbatim sentences the model picked', 2600);

			const second = await h.page.evaluate((selector) => {
				const heading = document.getElementById('Golden_age');
				return [...document.querySelectorAll(selector)].findIndex((p) => heading && heading.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
			}, wikiParagraphs);
			await scrollTo(second);
			await say('Second section: Golden age');
			await h.page.waitForTimeout(1200);
			await step(second, 2, 'A new section: the local fold first, then one model call for the section', 200);
			await waitForModel(second);
			await h.page.waitForTimeout(2600);
			await step(second + 1, 2, 'Its next paragraph is already folded by that call', 2600);
			await step(second + 2, 1, 'Each paragraph keeps its own level', 2600);
			await say('Two sections, two model calls, every other fold instant');
			await h.page.waitForTimeout(2500);
			expect(workerLines(h, 'fold request')).toHaveLength(2);
			await logUsage(h, 'video probe');
		} finally {
			await h.close();
		}
		await encode(videoDir, mp4);
	});

	test('fold three Korean paragraphs in two sections through every level and back', async ({ headless }) => {
		test.setTimeout(300_000);
		const videoDir = path.join(outDir, 'video-korean');
		const mp4 = path.join(outDir, 'p3-review-korean.mp4');
		await rm(videoDir, { recursive: true, force: true });
		await rm(mp4, { force: true });
		const h = await launch({ headless, allowLiveHosts: ['openrouter.ai'], recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
		const pictured = 3;
		const shown: Record<string, Overlay> = {};
		try {
			await setProvider(h, { apiKey: placeholder });
			const { say, step, waitForModel, scrollTo } = await presenter(h);
			const shoot = async (level: string) => {
				shown[level] = await overlay(h.page, wikiParagraphs, pictured);
				const clip = await h.page.evaluate(
					({ selector, pictured }) => {
						const el = document.querySelectorAll(selector)[pictured];
						const range = document.createRange();
						range.selectNodeContents((el?.checkVisibility() ? el : el?.nextElementSibling) ?? document.body);
						const lines = [...range.getClientRects()];
						const left = Math.min(...lines.map((line) => line.left)) - 16;
						const top = Math.min(...lines.map((line) => line.top)) - 16;
						const right = Math.max(...lines.map((line) => line.right)) + 16;
						const bottom = Math.max(...lines.map((line) => line.bottom)) + 16;
						return { x: Math.max(0, left), y: Math.max(0, top), width: right - left, height: bottom - top };
					},
					{ selector: wikiParagraphs, pictured },
				);
				await h.page.screenshot({ path: path.join(outDir, `p3-review-korean-${level}.png`), clip, style: '#tf-dot{display:none}' });
			};
			await h.navigate(koWiki);
			const original = await textOfOriginal(h.page, wikiParagraphs, pictured);
			await scrollTo(pictured);
			await say('Korean Wikipedia, 블랙홀: fold a paragraph through Brief, Key and Takeaway');
			await h.page.waitForTimeout(2000);
			await shoot('full');
			await step(pictured, 1, 'Brief: the local fold at once, then the sentences the model picked, verbatim', 200);
			await waitForModel(pictured);
			await h.page.waitForTimeout(2000);
			await shoot('brief');
			await step(pictured, 1, 'Key: the model writes the takeaway and its reason in Korean', 2000);
			await shoot('key');
			await step(pictured, 1, 'Takeaway: one Korean headline', 2000);
			await shoot('takeaway');
			await step(pictured, -3, 'Back to Full', 1500);
			await step(4, 1, 'Another paragraph in the same section: folded by the same call, no wait', 2000);
			await step(4, 1, 'Key', 2000);
			await step(4, 1, 'Takeaway', 2000);
			await step(4, -3, 'Back to Full', 1500);
			await scrollTo(11);
			await say('A second section, 황금시대: one more call for the whole section');
			await h.page.waitForTimeout(1500);
			await step(11, 1, 'Brief: the local fold first, then the model fold', 200);
			await waitForModel(11);
			await h.page.waitForTimeout(2000);
			await step(11, 1, 'Key', 2000);
			await step(11, 1, 'Takeaway', 2000);
			await step(11, -3, 'Back to Full', 1500);
			await logUsage(h, 'Korean video probe');
			const sentences = localFold(original).sentences;
			const brief = shown.brief?.text ?? '';
			console.log(`paragraph ${pictured}, Full: ${original}`);
			for (const level of ['brief', 'key', 'takeaway']) console.log(`paragraph ${pictured}, ${level}: ${shown[level]?.text}`);
			console.log(`Brief keeps sentences ${JSON.stringify(sentences.flatMap((sentence, i) => (brief.includes(sentence) ? [i] : [])))} of ${sentences.length}`);
			expect(workerLines(h, 'fold request')).toHaveLength(2);
			expect(shown.full).toMatchObject({ level: null });
			for (const [level, number] of [['brief', '1'], ['key', '2'], ['takeaway', '3']] as const) {
				expect(shown[level]).toMatchObject({ level: number, fold: 'model', badge: null });
			}
			let rest = brief;
			for (const sentence of sentences) if (rest.startsWith(sentence)) rest = rest.slice(sentence.length).trimStart();
			expect(rest).toBe('');
		} finally {
			await h.close();
		}
		await encode(videoDir, mp4);
	});
});

async function presenter(h: Harness) {
	await h.page.setViewportSize({ width: 1280, height: 720 });
	await h.page.addInitScript(() => {
		addEventListener('DOMContentLoaded', () => {
			const dot = document.body.appendChild(document.createElement('div'));
			dot.id = 'tf-dot';
			dot.style.cssText =
				'position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(220,40,40,.55);border:2px solid #fff;pointer-events:none;z-index:2147483647;left:-50px;top:-50px';
			const caption = document.body.appendChild(document.createElement('div'));
			caption.id = 'tf-caption';
			caption.style.cssText =
				'position:fixed;left:16px;bottom:16px;max-width:900px;padding:8px 14px;border-radius:8px;background:rgba(20,20,20,.85);color:#fff;font:600 18px system-ui;pointer-events:none;z-index:2147483647';
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
	const step = async (index: number, steps: number, text: string, hold = 1800) => {
		const point = await h.page.evaluate(
			({ selector, index }) => {
				const el = document.querySelectorAll(selector)[index];
				const visible = el?.checkVisibility() ? el : el?.nextElementSibling;
				const rect = visible?.getBoundingClientRect();
				if (!rect) throw new Error(`paragraph ${index} has no box`);
				return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 30) };
			},
			{ selector: wikiParagraphs, index },
		);
		await h.page.mouse.move(point.x, point.y, { steps: 12 });
		await h.page.waitForTimeout(700);
		await say(text);
		await h.foldAt(point.x, point.y, steps);
		await h.page.waitForTimeout(hold);
	};
	const waitForModel = (index: number) => settled(h, wikiParagraphs, index, modelFold);
	const scrollTo = async (index: number) => {
		await h.page.locator(nth(wikiParagraphs, index)).evaluate((el) => el.scrollIntoView({ block: 'start' }));
		await h.page.evaluate(() => scrollBy(0, -90));
		await h.page.waitForTimeout(1200);
	};
	return { say, step, waitForModel, scrollTo };
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
