import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { paragraphLanguage } from '../../src/fold/language.ts';
import { presets } from '../../src/fold/providers/presets.ts';
import type { StoredTranslation } from '../../src/translation.ts';
import { launch, type Harness } from '../harness.ts';
import { expect, test } from '../lane.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p6a');
const reading = '/reading-en/';
const paragraphs = 'article > p:not([data-tfold-overlay])';
const latchMs = 400;
const ogKey = process.env.OPENGATEWAY_API_KEY ?? '';
const ogHost = new URL(presets.opengateway.baseUrl).hostname;
const ogPrice = { input: 0.3e-6, output: 1.2e-6 };
const koreanReader: StoredTranslation = { autoTranslate: true, readerLanguage: 'ko' };
const asksKorean = 'The reader reads Korean';
const korean = {
	takeaway: 'Neil Armstrong(닐 암스트롱)과 Buzz Aldrin(버즈 올드린)이 1969년 7월 20일 달에 착륙했다',
	reason: '두 사람은 약 2시간 30분 동안 밖에서 암석과 토양 21.5킬로그램을 모았다',
};
const english = {
	takeaway: 'Neil Armstrong and Buzz Aldrin landed on the Moon on July 20, 1969',
	reason: 'They spent about two and a half hours outside and collected 21.5 kilograms of rock',
};
const glossedName = /\p{Lu}[\p{L}.'-]*(?: [\p{Lu}\p{Nd}][\p{L}\p{Nd}.'-]*)*\([^)]*\p{Script=Hangul}[^)]*\)/u;

const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const workerLines = (h: Harness, prefix: string) =>
	h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith(prefix)).map((entry) => entry.text);

type Usage = { provider: string; promptTokens: number; completionTokens: number; blocks: number; ms: number };
const usages = (h: Harness): Usage[] => workerLines(h, 'fold usage ').map((line) => JSON.parse(line.slice('fold usage '.length)) as Usage);

async function fresh(name: string): Promise<string> {
	const file = path.join(outDir, name);
	await mkdir(outDir, { recursive: true });
	await rm(file, { recursive: true, force: true });
	return file;
}

function sh(command: string, args: string[]): string {
	const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr}`);
	return result.stdout.trim();
}

type Mock = {
	baseUrl: string;
	prompts: string[];
	units: number[];
	hold: (prompt: string) => boolean;
	release(): void;
	close(): Promise<void>;
};

async function mockProvider(): Promise<Mock> {
	const held: (() => void)[] = [];
	const mock: Mock = {
		baseUrl: '',
		prompts: [],
		units: [],
		hold: () => false,
		release: () => {
			for (const answer of held.splice(0)) answer();
		},
		close: () => Promise.resolve(),
	};
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
			const lines = prompt.includes(asksKorean) ? korean : english;
			const units = [...prompt.matchAll(/^\[U(\d+)\]/gm)].map(([, n]) => ({ id: `U${n}`, ...lines, evidence: [0, 3] }));
			mock.prompts.push(prompt);
			mock.units.push(units.length);
			const answer = () => {
				response.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(
					JSON.stringify({
						id: 'gen-mock',
						choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ units }) } }],
						usage: { prompt_tokens: 0, completion_tokens: 0 },
					}),
				);
			};
			if (mock.hold(prompt)) held.push(answer);
			else answer();
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

async function seed(h: Harness, providers: object, translation: StoredTranslation): Promise<void> {
	await h.worker.evaluate(
		async ({ providers, translation }) => {
			await chrome.storage.local.set({ providers, hintSeen: true });
			await chrome.storage.sync.set(translation);
		},
		{ providers, translation },
	);
}

const seedMock = (h: Harness, mock: Mock, translation: StoredTranslation) =>
	seed(h, { chosen: 'openrouter', openrouter: { apiKey: 'mock', baseUrl: mock.baseUrl, model: 'mock/model' } }, translation);

async function translate(h: Harness, translation: StoredTranslation): Promise<void> {
	await h.worker.evaluate((translation) => chrome.storage.sync.set(translation), translation);
	await h.page.waitForTimeout(100);
}

type Overlay = { level: string | null; fold: string | null; lang: string | null; text: string | null; links: string[] };

function overlay(page: Page, index: number): Promise<Overlay> {
	return page.evaluate(
		({ selector, index }) => {
			const el = document.querySelectorAll(selector)[index];
			if (!el) throw new Error(`no paragraph ${index}`);
			const shown = el.nextElementSibling?.hasAttribute('data-tfold-overlay') ? el.nextElementSibling : null;
			return {
				level: shown?.getAttribute('data-tf-level') ?? null,
				fold: shown?.getAttribute('data-tf-fold') ?? null,
				lang: shown?.getAttribute('lang') ?? null,
				text: shown ? (shown.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
				links: shown ? [...shown.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '') : [],
			};
		},
		{ selector: paragraphs, index },
	);
}

async function settled(h: Harness, index: number, want: (shown: Overlay) => boolean, timeout = 20_000): Promise<Overlay> {
	await expect.poll(async () => want(await overlay(h.page, index)), { timeout, intervals: [50] }).toBe(true);
	return overlay(h.page, index);
}

async function foldNow(h: Harness, index: number, steps: number): Promise<void> {
	await h.page.evaluate(
		({ selector, index }) => {
			for (const marked of document.querySelectorAll('[data-p6a-target]')) marked.removeAttribute('data-p6a-target');
			const el = document.querySelectorAll(selector)[index];
			(el?.checkVisibility() ? el : el?.nextElementSibling)?.setAttribute('data-p6a-target', '');
		},
		{ selector: paragraphs, index },
	);
	const point = await h.pointAt('[data-p6a-target]');
	await h.foldAt(point.x, point.y, steps);
}

async function foldBy(h: Harness, index: number, steps: number): Promise<void> {
	await foldNow(h, index, steps);
	await h.page.waitForTimeout(latchMs);
}

const modelAt = (level: string) => (shown: Overlay) => shown.fold === 'model' && shown.level === level;
const settle = (page: Page) => page.waitForFunction(() => document.querySelector('tfold-ghosts') === null && document.getAnimations().length === 0);

// Counts the 2 by 2 pixel squares whose mean color changes. A glyph drawn a fraction of a pixel aside shades single
// pixels differently, and a glyph drawn in another font changes whole squares.
async function changedSquares(h: Harness, a: Buffer, b: Buffer): Promise<number> {
	const page = await h.context.newPage();
	try {
		return await page.evaluate(
			async ([a, b]) => {
				const read = async (png: string) => {
					const image = new Image();
					image.src = `data:image/png;base64,${png}`;
					await image.decode();
					const canvas = new OffscreenCanvas(image.width, image.height);
					const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
					context.drawImage(image, 0, 0);
					return context.getImageData(0, 0, image.width, image.height);
				};
				const [x, y] = await Promise.all([read(a), read(b)]);
				const square = [0, 1, x.width, x.width + 1];
				let changed = 0;
				for (let row = 0; row + 1 < x.height; row += 2) {
					for (let column = 0; column + 1 < x.width; column += 2) {
						const first = row * x.width + column;
						const delta = [0, 1, 2].reduce((sum, c) => {
							const shift = square.reduce((each, at) => each + (x.data[(first + at) * 4 + c] ?? 0) - (y.data[(first + at) * 4 + c] ?? 0), 0);
							return sum + Math.abs(shift) / square.length;
						}, 0);
						if (delta > 96) changed++;
					}
				}
				return changed;
			},
			[a.toString('base64'), b.toString('base64')] as const,
		);
	} finally {
		await page.close();
	}
}

function shownBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
	return page.locator(`${paragraphs} >> nth=0`).evaluate((el) => {
		const shown = el.nextElementSibling?.hasAttribute('data-tfold-overlay') ? el.nextElementSibling : el;
		const { left, top, width, height } = shown.getBoundingClientRect();
		return { x: Math.max(0, left - 4), y: Math.max(0, top - 8), width: width + 12, height: height + 16 };
	});
}

async function seekMorph(page: Page, end: 'first' | 'last'): Promise<void> {
	await page.evaluate((end) => {
		for (const animation of document.getAnimations()) {
			animation.pause();
			animation.currentTime = end === 'first' ? 0 : Number(animation.effect?.getComputedTiming().endTime ?? 1) - 1;
		}
	}, end);
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// Squares that change between the text at rest and the morph's first frame, and between its last frame and the text at
// rest after it, on the first paragraph.
async function morphJumps(h: Harness, steps: number): Promise<{ first: number; last: number }> {
	const before = await shownBox(h.page);
	const resting = await h.page.screenshot({ clip: before });
	await foldNow(h, 0, steps);
	await h.page.waitForFunction(() => document.querySelector('tfold-ghosts') !== null);
	await seekMorph(h.page, 'first');
	const first = await h.page.screenshot({ clip: before });
	await seekMorph(h.page, 'last');
	const after = await shownBox(h.page);
	const last = await h.page.screenshot({ clip: after });
	await h.page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
	await settle(h.page);
	const rested = await h.page.screenshot({ clip: after });
	await h.page.waitForTimeout(latchMs);
	return { first: await changedSquares(h, resting, first), last: await changedSquares(h, last, rested) };
}

async function shootTop(page: Page, name: string): Promise<void> {
	const box = await page.locator('article').boundingBox();
	if (!box) throw new Error('the article is not on screen');
	await page.screenshot({ path: await fresh(name), clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y), width: box.width + 32, height: 380 } });
}

test.describe('mock provider', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	test('lane 1: with auto-translate on, a Korean reader gets Key and Takeaway in Korean, and Brief keeps the English sentences and their link', async ({ h }) => {
		const mock = await mockProvider();
		try {
			await seedMock(h, mock, koreanReader);
			await h.navigate(reading);
			await foldBy(h, 0, 1);
			const brief = await settled(h, 0, modelAt('1'));
			await shootTop(h.page, 'p6a-brief.png');
			await foldBy(h, 0, 1);
			const key = await settled(h, 0, modelAt('2'));
			await settle(h.page);
			await shootTop(h.page, 'p6a-key.png');
			await foldBy(h, 0, 1);
			const takeaway = await settled(h, 0, modelAt('3'));
			console.log(`Brief: ${brief.text}\nKey: ${key.text}\nTakeaway: ${takeaway.text}`);
			console.log(`the mock saw ${mock.prompts.length} prompts with ${JSON.stringify(mock.units)} units`);
			expect(mock.units).toEqual([3]);
			expect(mock.prompts[0]).toContain(asksKorean);
			expect(mock.prompts[0]).toContain('takeaway: ONE Korean sentence');
			expect(brief.text).toMatch(/^On July 20, 1969, Neil Armstrong .* NASA flew the mission/);
			expect(brief).toMatchObject({ lang: null, links: ['#nasa'] });
			expect(key).toMatchObject({ lang: 'ko', text: `${korean.takeaway}. ${korean.reason}.`, links: [] });
			expect(takeaway).toMatchObject({ lang: 'ko', text: `${korean.takeaway}.` });
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});

	test('lane 2: a paragraph already in Korean folds with no translation, and with auto-translate off an English paragraph asks as it did before', async ({ h }) => {
		const mock = await mockProvider();
		try {
			await seedMock(h, mock, koreanReader);
			await h.navigate(reading);
			await foldBy(h, 12, 1);
			await settled(h, 12, modelAt('1'));
			await translate(h, { autoTranslate: false });
			await foldBy(h, 3, 2);
			const key = await settled(h, 3, modelAt('2'));
			console.log(`the Korean note asked: ${mock.prompts[0]?.includes(asksKorean) ? 'translated' : 'untranslated'}; Key with auto-translate off: ${key.text}`);
			expect(mock.units).toEqual([1, 3]);
			expect(mock.prompts[0]).not.toContain(asksKorean);
			expect(mock.prompts[0]).toContain('takeaway: ONE Korean sentence of at most 14 words');
			expect(mock.prompts[1]).not.toContain(asksKorean);
			expect(mock.prompts[1]).toContain('takeaway: ONE English sentence of at most 14 words');
			expect(key).toMatchObject({ lang: null, text: `${english.takeaway}. ${english.reason}.` });
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});

	test('lane 3: turning auto-translate off refolds a folded paragraph in English on the next fold, and turning it back on answers from the cache', async ({ h }) => {
		const mock = await mockProvider();
		try {
			await seedMock(h, mock, koreanReader);
			await h.navigate(reading);
			await foldBy(h, 0, 2);
			const first = await settled(h, 0, modelAt('2'));
			await translate(h, { autoTranslate: false });
			await foldBy(h, 0, -1);
			await foldBy(h, 0, 1);
			const off = await settled(h, 0, (shown) => modelAt('2')(shown) && shown.text === `${english.takeaway}. ${english.reason}.`);
			await translate(h, koreanReader);
			await foldBy(h, 0, -1);
			await foldBy(h, 0, 1);
			const on = await settled(h, 0, (shown) => modelAt('2')(shown) && shown.text === `${korean.takeaway}. ${korean.reason}.`);
			console.log(`Key on, off, on again: ${first.text} | ${off.text} | ${on.text}`);
			console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
			expect(first).toMatchObject({ lang: 'ko', text: `${korean.takeaway}. ${korean.reason}.` });
			expect(off.lang).toBeNull();
			expect(on.lang).toBe('ko');
			expect(mock.prompts.map((prompt) => prompt.includes(asksKorean))).toEqual([true, false]);
			expect(workerLines(h, 'fold cache hit')).toEqual(['fold cache hit, 3 blocks']);
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});

	test('lane 7: turning auto-translate off while a Korean fold is on its way asks again in English on the next fold, and the late Korean answer stays hidden', async ({ h }) => {
		const mock = await mockProvider();
		try {
			mock.hold = (prompt) => prompt.includes(asksKorean);
			await seedMock(h, mock, koreanReader);
			await h.navigate(reading);
			await foldBy(h, 0, 2);
			await expect.poll(() => mock.prompts.length).toBe(1);
			await translate(h, { autoTranslate: false });
			await foldBy(h, 0, 1);
			const takeaway = await settled(h, 0, (shown) => modelAt('3')(shown) && shown.text === `${english.takeaway}.`, 5_000);
			mock.release();
			await expect.poll(() => usages(h).length).toBe(2);
			await h.page.waitForTimeout(latchMs);
			const after = await overlay(h.page, 0);
			console.log(`asked: ${JSON.stringify(mock.prompts.map((prompt) => (prompt.includes(asksKorean) ? 'Korean' : 'English')))}; Takeaway ${takeaway.text}, after the Korean answer ${after.text}`);
			expect(mock.prompts.map((prompt) => prompt.includes(asksKorean))).toEqual([true, false]);
			expect(takeaway.lang).toBeNull();
			expect(after).toEqual(takeaway);
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});

	test('lane 6: settings show the auto-translate switch under the language choice, off at first, and turning it on makes the next fold Korean', async ({ h }) => {
		const mock = await mockProvider();
		try {
			await seedMock(h, mock, { readerLanguage: 'ko' });
			const settings = await h.context.newPage();
			await settings.setViewportSize({ width: 860, height: 900 });
			await settings.goto(`chrome-extension://${h.extensionId}/options/options.html`);
			const toggle = settings.locator('#auto-translate');
			const section = settings.locator('section[aria-labelledby="language-heading"]');
			await expect(settings.locator('#auto-translate-title')).toHaveText('다른 언어 문단은 한국어로 접기');
			const before = await toggle.getAttribute('aria-checked');
			await toggle.click();
			await expect(toggle).toHaveAttribute('aria-checked', 'true');
			const stored = await h.worker.evaluate(() => chrome.storage.sync.get(['autoTranslate', 'readerLanguage']));
			await section.screenshot({ path: await fresh('p6a-settings-ko-light.png'), animations: 'disabled' });
			await settings.locator('input[name="language"][value="en"]').check();
			await expect(settings.locator('#auto-translate-title')).toHaveText('Fold other languages into English');
			await settings.emulateMedia({ colorScheme: 'dark' });
			await section.screenshot({ path: await fresh('p6a-settings-en-dark.png'), animations: 'disabled' });
			await settings.locator('input[name="language"][value="ko"]').check();
			await settings.close();
			await h.navigate(reading);
			await foldBy(h, 0, 2);
			const key = await settled(h, 0, modelAt('2'));
			console.log(`switch before ${before}, stored ${JSON.stringify(stored)}, Key ${key.text}`);
			expect(before).toBe('false');
			expect(stored).toEqual({ autoTranslate: true, readerLanguage: 'ko' });
			expect(mock.prompts[0]).toContain(asksKorean);
			expect(key).toMatchObject({ lang: 'ko', text: `${korean.takeaway}. ${korean.reason}.` });
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});

	test('lane 5: Brief fades out whole into a translated Key, and Key to Takeaway still slides the Korean words they share', async ({ h }) => {
		const mock = await mockProvider();
		const ghosts = async () => {
			await h.page.waitForFunction(() => document.querySelector('tfold-ghosts') !== null);
			const seen = await h.page.evaluate(() => {
				const count = (kind: string) => document.querySelectorAll(`tfold-ghosts [data-tf-ghost="${kind}"]`).length;
				return { out: count('out'), in: count('in'), move: count('move') };
			});
			await settle(h.page);
			await h.page.waitForTimeout(latchMs);
			return seen;
		};
		try {
			await seedMock(h, mock, koreanReader);
			await h.navigate(reading);
			await foldBy(h, 0, 1);
			await settled(h, 0, modelAt('1'));
			await settle(h.page);
			await foldNow(h, 0, 1);
			const toKey = await ghosts();
			await foldNow(h, 0, 1);
			const toTakeaway = await ghosts();
			console.log(`Brief to Key ghosts ${JSON.stringify(toKey)}, Key to Takeaway ghosts ${JSON.stringify(toTakeaway)}`);
			expect(toKey.move).toBe(0);
			expect(toKey.out).toBeGreaterThan(30);
			expect(toKey.in).toBeGreaterThan(20);
			expect(toTakeaway.move).toBeGreaterThan(15);
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});

	test('lane 8: a morph into or out of Korean lines starts and ends on the text at rest, in the page font and in the default font, no more than an untranslated morph does', async ({ h }) => {
		const mock = await mockProvider();
		const jumps = async (style: string) => {
			await h.navigate(reading);
			if (style) await h.page.addStyleTag({ content: style });
			await foldBy(h, 0, 1);
			await settled(h, 0, modelAt('1'));
			await settle(h.page);
			const seen = [];
			for (const steps of [1, 1, -1, -1]) seen.push(await morphJumps(h, steps));
			return seen;
		};
		const fonts = async () => ({ page: await jumps(''), default: await jumps('body { font-family: initial }') });
		try {
			await seedMock(h, mock, koreanReader);
			const translated = await fonts();
			await translate(h, { autoTranslate: false });
			const untranslated = await fonts();
			console.log(`2 by 2 squares that jump at the first and the last frame of Brief to Key, Key to Takeaway, Takeaway to Key and Key to Brief:`);
			console.log(`translated ${JSON.stringify(translated)}\nuntranslated ${JSON.stringify(untranslated)}`);
			expect(mock.prompts.map((prompt) => prompt.includes(asksKorean))).toEqual([true, false]);
			// The untranslated morph also moves a few squares, so the largest jumps are compared.
			const largest = (seen: { first: number; last: number }[]) => Math.max(...seen.flatMap(({ first, last }) => [first, last]));
			for (const font of ['page', 'default'] as const) expect(largest(translated[font])).toBeLessThanOrEqual(largest(untranslated[font]));
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});
});

test.describe('a Korean page in the default font', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	test('lane 8: an untranslated Korean paragraph keeps its font through a morph, since its overlay does not name the font Chrome reports', async ({ h }) => {
		const mock = await mockProvider();
		try {
			await seedMock(h, mock, koreanReader);
			await h.navigate(reading);
			await h.page.addStyleTag({ content: 'body { font-family: initial }' });
			await h.page.evaluate((selector) => {
				document.documentElement.lang = 'ko';
				for (const [i, paragraph] of [...document.querySelectorAll(selector)].entries()) if (i !== 12) paragraph.remove();
			}, paragraphs);
			await foldBy(h, 0, 1);
			await settled(h, 0, modelAt('1'));
			await settle(h.page);
			await foldBy(h, 0, -1);
			await settle(h.page);
			const jumps = [await morphJumps(h, 1), await morphJumps(h, -1)];
			console.log(`Korean page, default font: ${JSON.stringify(jumps)}`);
			expect(Math.max(...jumps.flatMap(({ first, last }) => [first, last]))).toBeLessThanOrEqual(1);
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});
});

test.describe('live OpenGateway', () => {
	test.use({ allowLiveHosts: [ogHost] });
	test.skip(ogKey === '', 'OPENGATEWAY_API_KEY is not set');

	test('lane 4: a Korean reader folds an English paragraph live into Korean with the names kept and glossed, and the Korean note stays untranslated', async ({ h }) => {
		await seed(h, { chosen: 'opengateway', opengateway: { apiKey: ogKey } }, koreanReader);
		await h.navigate(reading);
		await foldBy(h, 0, 2);
		const key = await settled(h, 0, modelAt('2'));
		await settle(h.page);
		await shootTop(h.page, 'p6a-live-key.png');
		await foldBy(h, 12, 2);
		const note = await settled(h, 12, modelAt('2'));
		const calls = usages(h);
		const cost = calls.reduce((sum, usage) => sum + usage.promptTokens * ogPrice.input + usage.completionTokens * ogPrice.output, 0);
		console.log(`Key: ${key.text}\nKorean note Key: ${note.text}`);
		console.log(`calls: ${JSON.stringify(calls)}; about $${cost.toFixed(6)} at the list price`);
		expect(key.lang).toBe('ko');
		expect(paragraphLanguage('', key.text ?? '')).toEqual({ known: true, lang: 'ko' });
		expect(key.text).toMatch(glossedName);
		expect(note.lang).toBeNull();
		expect(paragraphLanguage('', note.text ?? '')).toEqual({ known: true, lang: 'ko' });
		expect(calls.map((usage) => usage.blocks)).toEqual([3, 1]);
		expect(errors(h)).toEqual([]);
	});
});

async function frameAt(page: Page, ms: number): Promise<Buffer> {
	await page.evaluate((ms) => {
		for (const animation of document.getAnimations()) {
			animation.pause();
			animation.currentTime = ms;
		}
	}, ms);
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	const box = await page.locator(`${paragraphs} >> nth=0`).evaluate((el) => {
		const shown = el.nextElementSibling?.hasAttribute('data-tfold-overlay') ? el.nextElementSibling : el;
		const { left, top, width } = shown.getBoundingClientRect();
		return { x: Math.max(0, left - 16), y: Math.max(0, top - 12), width: width + 32, height: 230 };
	});
	return page.screenshot({ clip: box });
}

async function filmstrip(page: Page, file: string, frames: { label: string; png: Buffer }[]): Promise<void> {
	const figures = frames
		.map(({ label, png }) => `<figure><figcaption>${label}</figcaption><img src="data:image/png;base64,${png.toString('base64')}"></figure>`)
		.join('');
	await page.setViewportSize({ width: 1500, height: 900 });
	await page.setContent(
		`<style>body{margin:0;background:#444;font:600 16px system-ui;color:#fff;display:grid;grid-template-columns:repeat(2,1fr);gap:6px}figure{margin:0}figcaption{padding:4px 8px}img{display:block;width:100%}</style>${figures}`,
	);
	await page.locator('body').screenshot({ path: file });
}

test.describe('transition probe', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });
	test.skip(process.env.TFOLD_PROBE !== 'transition', 'TFOLD_PROBE=transition pauses the Brief to Key morph at fixed times');

	test('Brief to Key and Key to Takeaway across languages, paused every 60 ms', async ({ h }) => {
		test.setTimeout(120_000);
		const mock = await mockProvider();
		try {
			await seedMock(h, mock, koreanReader);
			await h.navigate(reading);
			await foldBy(h, 0, 1);
			await settled(h, 0, modelAt('1'));
			await settle(h.page);
			for (const [from, to] of [
				['Brief', 'Key'],
				['Key', 'Takeaway'],
			] as const) {
				await foldNow(h, 0, 1);
				await h.page.waitForFunction(() => document.querySelector('tfold-ghosts') !== null);
				const moves = await h.page.evaluate(() => [...document.querySelectorAll('tfold-ghosts [data-tf-ghost="move"]')].map((ghost) => ghost.textContent).join(' '));
				const frames = [];
				for (const ms of [0, 60, 120, 180, 240, 300, 360, 480]) frames.push({ label: `${from} to ${to}, ${ms} ms`, png: await frameAt(h.page, ms) });
				console.log(`${from} to ${to}: moving ghosts ${moves || '(none)'}`);
				await h.page.evaluate(() => document.getAnimations().forEach((animation) => animation.finish()));
				await settle(h.page);
				await h.page.waitForTimeout(latchMs);
				const strip = await h.context.newPage();
				await filmstrip(strip, await fresh(`p6a-${from.toLowerCase()}-${to.toLowerCase()}.png`), frames);
				await strip.close();
			}
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});
});

async function encode(videoDir: string, mp4: string): Promise<void> {
	const [webm] = (await readdir(videoDir)).filter((name) => name.endsWith('.webm'));
	if (!webm) throw new Error('Playwright wrote no video');
	sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(videoDir, webm), '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
	const { size } = await stat(mp4);
	console.log(`${path.basename(mp4)}: ${(size / 1e6).toFixed(2)} MB`);
}

test.describe('video probe', () => {
	test.skip(process.env.TFOLD_PROBE !== 'video', 'TFOLD_PROBE=video records the review video');
	test.skip(ogKey === '', 'OPENGATEWAY_API_KEY is not set');

	test('a Korean reader folds English paragraphs through every level, live', async ({ headless }) => {
		test.setTimeout(180_000);
		const videoDir = await fresh('video');
		const mp4 = await fresh('p6a-review.mp4');
		const h = await launch({ headless, allowLiveHosts: [ogHost], recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
		try {
			await seed(h, { chosen: 'opengateway', opengateway: { apiKey: ogKey } }, koreanReader);
			await h.navigate(reading);
			await h.page.waitForTimeout(800);
			await foldBy(h, 0, 1);
			await settled(h, 0, modelAt('1'));
			await h.page.waitForTimeout(1600);
			for (const steps of [1, 1, -1, -1, -1]) {
				await foldBy(h, 0, steps);
				await h.page.waitForTimeout(1600);
			}
			await foldBy(h, 4, 2);
			await settled(h, 4, modelAt('2'));
			await h.page.waitForTimeout(2400);
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
		await encode(videoDir, mp4);
	});
});
