import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { fixtures, launch, type Harness } from '../harness.ts';
import { expect, test } from '../lane.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p4');
const latchMs = 400;
const wikiParagraphs = '#mw-content-text section > p:not(.mw-empty-elt):not([data-tfold-overlay])';
const koWiki = '/wikipedia-ko-black-hole/';
const arxivFormulas = '[id="S2.SS1.p1.1"]';

const nth = (selector: string, index: number) => `${selector} >> nth=${index}`;
const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');

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

function written(sentence: string): { takeaway: string; reason: string } {
	const words = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
	const korean = /\p{Script=Hangul}/u.test(sentence);
	const pick = (from: number, to: number) => words.slice(from, to).join(' ');
	return {
		takeaway: `${pick(3, 5)} ${pick(0, 3)} ${pick(5, 9)} ${korean ? '중요하다' : 'matters'}`,
		reason: `${korean ? '이는' : 'It'} ${pick(9, 16)}`,
	};
}

function mockAnswer(prompt: string): string {
	const units = prompt.split(/^\[U\d+\][^\n]*\n/m).slice(1);
	return JSON.stringify({
		units: units.map((unit, n) => {
			const sentences = [...unit.matchAll(/^ {2}\d+: (.*)$/gm)].map(([, sentence]) => sentence ?? '');
			const evidence = sentences.length > 2 ? 1 : 0;
			return { id: `U${n}`, ...written(sentences[evidence] ?? ''), evidence: [evidence] };
		}),
	});
}

async function mockProvider(h: Harness): Promise<() => Promise<void>> {
	const server = http.createServer((request, response) => {
		const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
		if (request.method === 'OPTIONS') {
			response.writeHead(204, cors).end();
			return;
		}
		let raw = '';
		request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		request.on('end', () => {
			const body = JSON.parse(raw) as { messages: { content: string }[] };
			const content = mockAnswer(body.messages.at(-1)?.content ?? '');
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
	await h.worker.evaluate((provider) => chrome.storage.local.set({ provider }), {
		kind: 'openai-compatible',
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: 'mock-key',
		model: 'mock/model',
	});
	return async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	};
}

type Ghost = { id: string; at: number; kind: string; x: number; y: number; opacity: number; text: string; formulas: string[] };
type Frame = { t: number; ghosts: Ghost[]; scroll: number };
type Recorder = { frames: Frame[]; stopped: boolean };
type Point = { x: number; y: number; opacity: number; text: string };

function record(page: Page, every = 1): Promise<void> {
	return page.evaluate((every) => {
		const recorder: Recorder = { frames: [], stopped: false };
		Object.assign(globalThis, { recorder });
		let count = 0;
		const tick = (t: number) => {
			if (count++ % every === 0) {
				recorder.frames.push({
					t,
					ghosts: [...document.querySelectorAll('tfold-ghosts [data-tf-w]')].map((el) => {
						const rect = el.getBoundingClientRect();
						return {
							id: el.getAttribute('data-tf-w') ?? '',
							at: Number(el.getAttribute('data-tf-at') ?? 0),
							kind: el.getAttribute('data-tf-ghost') ?? '',
							x: rect.left,
							y: rect.top,
							opacity: Number(getComputedStyle(el).opacity) * Number(el.parentElement ? getComputedStyle(el.parentElement).opacity : 1),
							text: el.textContent ?? '',
							formulas: [...el.querySelectorAll('math')].map((math) => math.textContent ?? ''),
						};
					}),
					scroll: scrollY,
				});
			}
			if (!recorder.stopped) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, every);
}

function recorded(page: Page): Promise<Frame[]> {
	return page.evaluate(() => {
		const { recorder } = globalThis as unknown as { recorder: Recorder };
		recorder.stopped = true;
		return recorder.frames;
	});
}

const morphing = (frames: Frame[]) => frames.filter((frame) => frame.ghosts.length > 0);
const leftovers = (page: Page) => page.locator('tfold-ghosts, tfold-gap, tfold-w').count();
const hiddenRanges = (page: Page) => page.evaluate(() => CSS.highlights.get('tfold-morph')?.size ?? 0);

async function settle(page: Page): Promise<void> {
	await page.waitForFunction(() => document.querySelector('tfold-ghosts, tfold-gap') === null);
	await page.waitForTimeout(100);
}

async function foldBy(h: Harness, selector: string, steps: number): Promise<void> {
	const point = await h.pointAt(selector);
	await h.foldAt(point.x, point.y, steps);
}

async function target(h: Harness, page: string, index: number): Promise<string> {
	await h.navigate(page);
	await h.page.locator(nth(wikiParagraphs, index)).evaluate((el) => {
		el.setAttribute('data-p4-paragraph', '');
		el.scrollIntoView({ block: 'start' });
		scrollBy(0, -160);
	});
	return '[data-p4-paragraph]';
}

const overlayOf = (paragraph: string) => `${paragraph} + [data-tfold-overlay]`;

async function foldWithModel(h: Harness, paragraph: string): Promise<void> {
	await foldBy(h, paragraph, 1);
	await expect(h.page.locator(`${overlayOf(paragraph)}[data-tf-fold="model"]`)).toHaveCount(1, { timeout: 15_000 });
	await settle(h.page);
	await h.page.waitForTimeout(latchMs);
}

async function unfold(h: Harness, paragraph: string): Promise<void> {
	await foldBy(h, overlayOf(paragraph), -1);
	await expect(h.page.locator(overlayOf(paragraph))).toHaveCount(0);
	await settle(h.page);
	await h.page.waitForTimeout(latchMs);
}

async function unfoldTo(h: Harness, paragraph: string, steps: number): Promise<void> {
	await h.page.waitForTimeout(latchMs);
	await foldBy(h, overlayOf(paragraph), -steps);
	await settle(h.page);
	await h.page.waitForTimeout(latchMs);
}

async function freeze(page: Page, ms: number): Promise<void> {
	await page.waitForFunction(() => document.querySelector('tfold-ghosts') !== null);
	await page.evaluate((ms) => {
		for (const animation of document.getAnimations()) {
			animation.pause();
			animation.currentTime = ms;
		}
		document.documentElement.getBoundingClientRect();
	}, ms);
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function thaw(page: Page): Promise<void> {
	await page.evaluate(() => document.getAnimations().forEach((animation) => animation.play()));
	await settle(page);
}

function trails(frames: Frame[], kind: string): Map<string, Point[]> {
	const byId = new Map<string, Point[]>();
	for (const frame of frames) {
		for (const ghost of frame.ghosts) {
			const key = `${ghost.id}@${ghost.at}`;
			if (ghost.kind === kind) byId.set(key, [...(byId.get(key) ?? []), ghost]);
		}
	}
	return byId;
}

function wordsOf(ghosts: Ghost[]): Map<string, string> {
	const pieces = new Map<string, Ghost[]>();
	for (const ghost of ghosts) pieces.set(ghost.id, [...(pieces.get(ghost.id) ?? []), ghost]);
	return new Map([...pieces].map(([id, parts]) => [id, parts.toSorted((a, b) => a.at - b.at).map((part) => part.text).join('')]));
}

function travelled(trail: Point[]): number {
	const [first, last] = [trail[0], trail.at(-1)];
	return first && last ? Math.hypot(last.x - first.x, last.y - first.y) : 0;
}

function movingFrames(frames: Frame[]): number {
	return frames.filter((frame, i) => {
		const previous = new Map((frames[i - 1]?.ghosts ?? []).map((ghost) => [`${ghost.id}@${ghost.at}`, ghost]));
		return frame.ghosts.some((ghost) => {
			const before = previous.get(`${ghost.id}@${ghost.at}`);
			return ghost.kind === 'move' && before !== undefined && Math.hypot(ghost.x - before.x, ghost.y - before.y) > 0.2;
		});
	}).length;
}

type Seen = { id: string; at: number; kind: string; text: string; atom: boolean; opacity: number; left: number; top: number; right: number; bottom: number };
type Run = { text: string; left: number; top: number; bottom: number };
type Paused = { t: number; ghosts: Seen[] };

type Overlap = { ms: number; px2: number };

const shotPauses = [0, 40, 80, 160, 240, 320];
const pauseStepMs = 10;
const grazePx = 3;
const midMs = 210;
const shownFloor = 0.1;

// Rows may graze while they slide, so lanes 11 and 12 hold the overlap to a recorded baseline instead of to zero. ms
// counts the 10 ms pauses in which two visible words share more than 3 px by 3 px; px2 is the largest total shared
// area in one pause. Three recorded runs agreed to the px², because every pause sets the same currentTime, so the
// slack absorbs no run-to-run noise. It allows one more pause and 5% more area, about a half pixel on each edge of a
// graze, so a font or Chrome point release that shifts a glyph does not fail the lanes.
const overlapBaseline: Record<string, Overlap> = {
	'English 1 Full to Brief': { ms: 40, px2: 326 },
	'English 1 Brief to Full': { ms: 40, px2: 326 },
	'English 3 Full to Brief': { ms: 40, px2: 302 },
	'English 3 Brief to Full': { ms: 40, px2: 302 },
	'Korean 3 Full to Brief': { ms: 10, px2: 49 },
	'Korean 3 Brief to Full': { ms: 10, px2: 49 },
	'Korean 5 Full to Brief': { ms: 90, px2: 216 },
	'Korean 5 Brief to Full': { ms: 100, px2: 992 },
};
const overlapSlack = { ms: pauseStepMs, area: 0.05 };

function seenAt(page: Page, ms: number): Promise<Seen[]> {
	return page.evaluate((ms) => {
		for (const animation of document.getAnimations()) {
			animation.pause();
			animation.currentTime = ms;
		}
		return [...document.querySelectorAll('tfold-ghosts [data-tf-w]')].map((el) => {
			const content = el.firstChild;
			const range = document.createRange();
			range.selectNodeContents(el);
			const box = content instanceof Element ? content.getBoundingClientRect() : range.getBoundingClientRect();
			let opacity = 1;
			for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
			return {
				id: el.getAttribute('data-tf-w') ?? '',
				at: Number(el.getAttribute('data-tf-at') ?? 0),
				kind: el.getAttribute('data-tf-ghost') ?? '',
				text: el.textContent ?? '',
				atom: content instanceof Element,
				opacity,
				left: box.left,
				top: box.top,
				right: box.right,
				bottom: box.bottom,
			};
		});
	}, ms);
}

function textRuns(page: Page, selector: string): Promise<Run[]> {
	return page.locator(selector).evaluate((root) => {
		const unread = 'math, .mwe-math-element, .katex, mjx-container, .MathJax, sup, sub, button, select, textarea, style, script, noscript';
		const runs: { text: string; left: number; top: number; bottom: number }[] = [];
		const range = document.createRange();
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node instanceof Text; node = walker.nextNode()) {
			const parent = node.parentElement;
			const mark = parent?.closest('sup');
			if (!parent || parent.closest(unread) || (mark && /^\[[^\]]*\]$/.test((mark.textContent ?? '').trim()))) continue;
			for (const { 0: char, index } of node.data.matchAll(/\S/gu)) {
				range.setStart(node, index);
				range.setEnd(node, index + char.length);
				const rect = range.getBoundingClientRect();
				if (rect.width > 0) runs.push({ text: char, left: rect.left, top: rect.top, bottom: rect.bottom });
			}
		}
		return runs;
	});
}

function lines(runs: Run[]): string[] {
	const rows: Run[][] = [];
	for (const run of runs.toSorted((a, b) => a.top + a.bottom - b.top - b.bottom)) {
		const row = rows.at(-1);
		const first = row?.[0];
		if (row && first && Math.abs(run.top + run.bottom - first.top - first.bottom) / 2 < (first.bottom - first.top) / 2) row.push(run);
		else rows.push([run]);
	}
	return rows.map((row) => row.toSorted((a, b) => a.left - b.left).map((run) => run.text).join(''));
}

const readable = (ghosts: Seen[]) => ghosts.filter((ghost) => !ghost.atom && ghost.opacity > 0.5);

function grazes(ghosts: Seen[]): { pair: string; px2: number }[] {
	const shown = ghosts.filter((ghost) => ghost.opacity > shownFloor);
	return shown.flatMap((a, i) =>
		shown.slice(i + 1).flatMap((b) => {
			const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
			const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
			const pair = `${a.kind} "${a.text}" ${a.opacity.toFixed(2)} and ${b.kind} "${b.text}" ${b.opacity.toFixed(2)} share ${Math.round(width)}x${Math.round(height)} px`;
			return width > grazePx && height > grazePx ? [{ pair, px2: width * height }] : [];
		}),
	);
}

function worseThanBaseline(measured: Record<string, Overlap>): string[] {
	return Object.entries(measured).flatMap(([key, now]) => {
		const was = overlapBaseline[key];
		if (!was) return [`${key}: ${now.ms} ms and ${now.px2} px² with no baseline`];
		const worse = now.ms > was.ms + overlapSlack.ms || now.px2 > was.px2 * (1 + overlapSlack.area);
		return worse ? [`${key}: ${now.ms} ms and ${now.px2} px², baseline ${was.ms} ms and ${was.px2} px²`] : [];
	});
}

function doubled(ghosts: Seen[]): string[] {
	const byWord = new Map<string, Seen[]>();
	for (const ghost of ghosts.filter((ghost) => ghost.opacity > shownFloor)) byWord.set(ghost.id, [...(byWord.get(ghost.id) ?? []), ghost]);
	return [...byWord].flatMap(([id, pieces]) => {
		const sorted = pieces.toSorted((a, b) => a.at - b.at);
		const twice = sorted.filter((piece, i) => i > 0 && piece.at < (sorted[i - 1]?.at ?? 0) + (sorted[i - 1]?.text.length ?? 0));
		const faded = sorted.filter((piece) => piece.kind === 'move' && piece.opacity < 0.5);
		return [...twice.map((piece) => `word ${id} shows "${piece.text}" twice`), ...faded.map((piece) => `kept "${piece.text}" faded to ${piece.opacity.toFixed(2)}`)];
	});
}

async function pausedMorph(h: Harness, shown: string, steps: number, slug: string): Promise<{ before: string[]; frames: Paused[] }> {
	const before = lines(await textRuns(h.page, shown));
	const point = await h.pointAt(shown);
	await h.foldAt(point.x, point.y, steps);
	await h.page.waitForFunction(() => document.querySelector('tfold-ghosts') !== null);
	const end = await h.page.evaluate(() => Math.max(...document.getAnimations().map((animation) => Number(animation.effect?.getComputedTiming().endTime ?? 0))));
	const grid = Array.from({ length: Math.floor(end / pauseStepMs) + 1 }, (_, i) => i * pauseStepMs);
	const frames: Paused[] = [];
	for (const t of [...grid, end]) {
		frames.push({ t, ghosts: await seenAt(h.page, t) });
		if (t !== end && !shotPauses.includes(t)) continue;
		await h.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		await h.page.screenshot({ path: await fresh(`${slug}-${String(Math.round(t)).padStart(3, '0')}ms`) });
	}
	await thaw(h.page);
	return { before, frames };
}

function checkPaused(label: string, before: string[], after: string[], frames: Paused[]): Overlap {
	const [first, last] = [frames[0], frames.at(-1)];
	const areas: number[] = [];
	for (const frame of frames.slice(0, -1)) {
		const shared = grazes(frame.ghosts);
		const twice = doubled(frame.ghosts);
		areas.push(shared.reduce((sum, graze) => sum + graze.px2, 0));
		if (shared.length + twice.length === 0) continue;
		console.log(`${label} at ${Math.round(frame.t)} ms: ${frame.ghosts.length} ghosts, ${shared.length} pairs overlap, ${twice.length} doubled or faded`);
		for (const line of [...shared.map((graze) => graze.pair), ...twice].slice(0, 6)) console.log(`  ${line}`);
	}
	expect(lines(readable(first?.ghosts ?? [])), `${label}: the first frame shows the text as it was`).toEqual(before);
	expect(lines(readable(last?.ghosts ?? [])), `${label}: the last frame shows the text as it ends`).toEqual(after);
	for (const frame of frames) expect(doubled(frame.ghosts), `${label}: words doubled or faded at ${Math.round(frame.t)} ms`).toEqual([]);
	const overlap = { ms: areas.filter((area) => area > 0).length * pauseStepMs, px2: Math.round(Math.max(0, ...areas)) };
	console.log(`${label}: ${frames.length - 1} pauses, overlap for ${overlap.ms} ms, at most ${overlap.px2} px²`);
	return overlap;
}

test.describe('lanes with a mock model', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	test('lane 1: a fold slides the kept words over at least 5 frames', async ({ h }) => {
		test.setTimeout(120_000);
		const png = await fresh('p4-slide');
		const close = await mockProvider(h);
		const paragraph = await target(h, fixtures.wiki, 1);
		await foldWithModel(h, paragraph);
		await unfold(h, paragraph);
		await close();
		await record(h.page);
		await foldBy(h, paragraph, 1);
		await h.page.waitForTimeout(900);
		const frames = await recorded(h.page);
		const kept = trails(frames, 'move');
		const moved = [...kept.values()].filter((trail) => travelled(trail) > 4);
		const moving = movingFrames(frames);
		console.log(`${moving} frames in which kept words moved, ${moved.length} of ${kept.size} kept words travelled more than 4 px`);

		await unfold(h, paragraph);
		await foldBy(h, paragraph, 1);
		await freeze(h.page, midMs);
		await h.page.screenshot({ path: png, clip: { x: 0, y: 120, width: 820, height: 330 } });
		await thaw(h.page);

		expect(moved.length).toBeGreaterThan(5);
		expect(moving).toBeGreaterThanOrEqual(5);
		expect(errors(h)).toEqual([]);
	});

	test('lane 2: a frame in mid-morph shows every kept word on its way, inside the box between its old and new place', async ({ h }) => {
		test.setTimeout(120_000);
		const png = await fresh('p4-midframe');
		const close = await mockProvider(h);
		const paragraph = await target(h, fixtures.wiki, 1);
		await foldWithModel(h, paragraph);
		await unfold(h, paragraph);
		await close();
		await foldBy(h, paragraph, 1);
		await h.page.waitForFunction(() => document.querySelector('tfold-ghosts') !== null);
		const at = (time: number) =>
			h.page.evaluate((time) => {
				for (const animation of document.getAnimations()) {
					animation.pause();
					animation.currentTime = time;
				}
				return [...document.querySelectorAll('tfold-ghosts [data-tf-ghost="move"]')].map((el) => {
					const rect = el.getBoundingClientRect();
					return { id: `${el.getAttribute('data-tf-w')}@${el.getAttribute('data-tf-at') ?? 0}`, text: el.textContent ?? '', x: rect.left, y: rect.top };
				});
			}, time);
		const [start, mid] = [await at(0), await at(midMs)];
		await freeze(h.page, midMs);
		await h.page.screenshot({ path: png });
		const end = await at(400);
		const hiddenWhileMoving = await hiddenRanges(h.page);
		await h.page.evaluate(() => document.getAnimations().forEach((animation) => animation.play()));
		await settle(h.page);
		const place = (frame: typeof start, id: string) => frame.find((ghost) => ghost.id === id);
		const kept = start.filter((ghost) => {
			const last = place(end, ghost.id);
			return last !== undefined && Math.hypot(last.x - ghost.x, last.y - ghost.y) > 4;
		});
		const between = kept.filter((first) => {
			const [last, now] = [place(end, first.id), place(mid, first.id)];
			if (!last || !now) return false;
			const inside = (a: number, b: number, x: number) => Math.min(a, b) - 1 <= x && x <= Math.max(a, b) + 1;
			const done = Math.hypot(now.x - first.x, now.y - first.y);
			const left = Math.hypot(last.x - now.x, last.y - now.y);
			return done > 1 && left > 1 && inside(first.x, last.x, now.x) && inside(first.y, last.y, now.y);
		});
		console.log(`paused ${midMs} ms into the morph: ${between.length} of ${kept.length} kept words are on their way inside the box between their old and new place`);
		console.log(`kept words: ${kept.map((ghost) => ghost.text).join(' ')}`);
		expect(kept.length).toBeGreaterThan(5);
		expect(between.length).toBe(kept.length);
		expect(hiddenWhileMoving).toBe(1);
		expect(await leftovers(h.page)).toBe(0);
		expect(await hiddenRanges(h.page)).toBe(0);
		expect(errors(h)).toEqual([]);
	});

	test('lane 3: Brief to Key fades the model-written words in and slides the kept words', async ({ h }) => {
		test.setTimeout(120_000);
		const png = await fresh('p4-brief-key');
		const close = await mockProvider(h);
		const paragraph = await target(h, fixtures.wiki, 1);
		await foldWithModel(h, paragraph);
		await close();
		await record(h.page);
		await foldBy(h, overlayOf(paragraph), 1);
		await settle(h.page);
		const frames = morphing(await recorded(h.page));
		await unfoldTo(h, paragraph, 1);
		await foldBy(h, overlayOf(paragraph), 1);
		await freeze(h.page, 240);
		await h.page.screenshot({ path: png });
		await thaw(h.page);
		const level = await h.page.locator(overlayOf(paragraph)).getAttribute('data-tf-level');
		const writtenWords = [...trails(frames, 'in').entries()].filter(([id]) => id.startsWith('k'));
		const fadedIn = writtenWords.filter(([, trail]) => (trail[0]?.opacity ?? 1) < 0.1 && Math.max(...trail.map((point) => point.opacity)) > 0.9);
		const kept = [...trails(frames, 'move').entries()].filter(([key]) => /^\d+@/.test(key));
		const slid = kept.filter(([, trail]) => travelled(trail) > 4);
		console.log(`model-written words that faded in: ${fadedIn.map(([, trail]) => trail[0]?.text).join(' ')}`);
		console.log(`Brief words that slid into the Key line: ${slid.map(([, trail]) => trail[0]?.text).join(' ')}`);
		expect(level).toBe('2');
		expect(fadedIn.length).toBeGreaterThan(0);
		expect(fadedIn.length).toBe(writtenWords.length);
		expect(slid.length).toBeGreaterThan(3);
		expect(errors(h)).toEqual([]);
	});

	test('lane 6: Korean words keep their ids from Full through Brief and Key', async ({ h }) => {
		test.setTimeout(120_000);
		const png = await fresh('p4-korean');
		const close = await mockProvider(h);
		await h.worker.evaluate(() => chrome.storage.sync.set({ autoTranslate: false }));
		const paragraph = await target(h, koWiki, 3);
		await foldWithModel(h, paragraph);
		await unfold(h, paragraph);
		await close();
		await record(h.page);
		await foldBy(h, paragraph, 1);
		await settle(h.page);
		const toBrief = morphing(await recorded(h.page));
		await h.page.waitForTimeout(latchMs);
		await record(h.page);
		await foldBy(h, overlayOf(paragraph), 1);
		await settle(h.page);
		const toKey = morphing(await recorded(h.page));
		await unfoldTo(h, paragraph, 1);
		await foldBy(h, overlayOf(paragraph), 1);
		await freeze(h.page, 120);
		await h.page.screenshot({ path: png });
		await thaw(h.page);
		const hangul = /\p{Script=Hangul}/u;
		const fromFull = wordsOf((toBrief[0]?.ghosts ?? []).filter((ghost) => ghost.kind === 'move'));
		const briefWords = wordsOf((toKey[0]?.ghosts ?? []).filter((ghost) => ghost.kind !== 'in'));
		const keyKept = [...wordsOf((toKey[0]?.ghosts ?? []).filter((ghost) => ghost.kind === 'move'))];
		const changed = [...briefWords].filter(([id, text]) => fromFull.get(id) !== text);
		console.log(`Full to Brief: ${fromFull.size} kept words, ${[...fromFull.values()].filter((text) => hangul.test(text)).length} in Hangul`);
		console.log(`Brief to Key: ${keyKept.length} kept words: ${keyKept.map(([, text]) => text).join(' ')}`);
		console.log(`Brief words: ${JSON.stringify([...briefWords])}`);
		console.log(`Brief words whose id has another word or none in Full: ${JSON.stringify(changed)}`);
		expect([...fromFull.values()].filter((text) => hangul.test(text)).length).toBeGreaterThan(5);
		expect(briefWords.size).toBeGreaterThan(5);
		expect(changed).toEqual([]);
		expect(keyKept.filter(([id, text]) => hangul.test(text) && briefWords.get(id) === text).length).toBeGreaterThan(3);
		expect(errors(h)).toEqual([]);
	});

	for (const { lane, name, page, indexes, slug } of [
		{ lane: 11, name: 'English', page: fixtures.wiki, indexes: [1, 3], slug: 'p4-paused-english' },
		{ lane: 12, name: 'Korean', page: koWiki, indexes: [3, 5], slug: 'p4-paused-korean' },
	]) {
		test(`lane ${lane}: no paused frame of a ${name} fold or unfold doubles or drops words, and rows overlap no more than the recorded baseline`, async ({ h }) => {
			test.setTimeout(300_000);
			const close = await mockProvider(h);
			const measured: Record<string, Overlap> = {};
			for (const index of indexes) {
				const paragraph = await target(h, page, index);
				await foldWithModel(h, paragraph);
				await unfold(h, paragraph);
				const fold = await pausedMorph(h, paragraph, 1, `${slug}-${index}-fold`);
				const brief = lines(await textRuns(h.page, overlayOf(paragraph)));
				await h.page.waitForTimeout(latchMs);
				const unfolded = await pausedMorph(h, overlayOf(paragraph), -1, `${slug}-${index}-unfold`);
				const full = lines(await textRuns(h.page, paragraph));
				measured[`${name} ${index} Full to Brief`] = checkPaused(`${name} paragraph ${index} Full to Brief`, fold.before, brief, fold.frames);
				measured[`${name} ${index} Brief to Full`] = checkPaused(`${name} paragraph ${index} Brief to Full`, unfolded.before, full, unfolded.frames);
			}
			await close();
			console.log(`overlap measured: ${JSON.stringify(measured)}`);
			expect(
				worseThanBaseline(measured),
				'rows overlap longer or wider than the recorded baseline, the most grazing the lanes accept',
			).toEqual([]);
			expect(errors(h)).toEqual([]);
		});
	}
});

test('lane 4: a fast unfold through every level ends at Full with the original untouched and no ghost left', async ({ h }) => {
	const png = await fresh('p4-fast');
	const paragraph = await target(h, fixtures.wiki, 1);
	const snapshot = await h.page.locator(paragraph).evaluate((el) => el.outerHTML);
	await foldBy(h, paragraph, 3);
	await settle(h.page);
	await h.page.waitForTimeout(latchMs);
	await record(h.page);
	await foldBy(h, overlayOf(paragraph), -3);
	await settle(h.page);
	const frames = await recorded(h.page);
	await h.page.screenshot({ path: png });
	const restored = await h.page.locator(paragraph).evaluate((el) => el.outerHTML);
	const blocks = await h.readBlocks();
	console.log(`${morphing(frames).length} frames with ghosts during the unfold`);
	expect(morphing(frames).length).toBeGreaterThan(0);
	expect(blocks.every((block) => block.level === 0)).toBe(true);
	expect(restored).toBe(snapshot);
	expect(await h.page.locator('[data-tfold-overlay], [data-tfold-hidden]').count()).toBe(0);
	expect(await leftovers(h.page)).toBe(0);
	expect(await hiddenRanges(h.page)).toBe(0);
	expect(await h.page.evaluate(() => document.getAnimations().length)).toBe(0);
	expect(errors(h)).toEqual([]);
});

test('lane 5: with reduced motion the level swaps with no ghost and no transform', async ({ h }) => {
	const png = await fresh('p4-reduced');
	await h.page.emulateMedia({ reducedMotion: 'reduce' });
	const paragraph = await target(h, fixtures.wiki, 1);
	const transforms = () => h.page.evaluate(() => [...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).transform !== 'none').length);
	const transformsBefore = await transforms();
	await h.page.evaluate(() => {
		const inserted: string[] = [];
		Object.assign(globalThis, { inserted });
		new MutationObserver((records) => {
			for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) inserted.push(node.localName);
		}).observe(document.documentElement, { childList: true, subtree: true });
	});
	await foldBy(h, paragraph, 1);
	await h.page.waitForTimeout(600);
	await h.page.screenshot({ path: png });
	const inserted = await h.page.evaluate(() => (globalThis as unknown as { inserted: string[] }).inserted);
	console.log(`elements added to the page during the how: ${JSON.stringify(inserted)}`);
	expect(await h.page.locator(overlayOf(paragraph)).getAttribute('data-tf-level')).toBe('1');
	expect(inserted.filter((name) => name.startsWith('tfold-'))).toEqual([]);
	expect(await h.page.evaluate(() => document.getAnimations().length)).toBe(0);
	expect(await transforms()).toBe(transformsBefore);
	expect(await hiddenRanges(h.page)).toBe(0);
});

test('lane 7: a scroll during the morph leaves no ghost floating once it ends', async ({ h }) => {
	const png = await fresh('p4-scroll');
	const paragraph = await target(h, fixtures.wiki, 1);
	await record(h.page);
	await foldBy(h, paragraph, 1);
	for (let i = 0; i < 6; i++) await h.page.mouse.wheel(0, 60);
	await settle(h.page);
	await h.page.waitForTimeout(300);
	const frames = await recorded(h.page);
	await h.page.screenshot({ path: png });
	const ghostFrames = morphing(frames);
	const scrolls = new Set(ghostFrames.map((frame) => frame.scroll));
	console.log(`${ghostFrames.length} frames with ghosts, at ${scrolls.size} scroll positions from ${Math.min(...scrolls)} to ${Math.max(...scrolls)} px`);
	expect(scrolls.size).toBeGreaterThan(2);
	expect(await leftovers(h.page)).toBe(0);
	expect(await hiddenRanges(h.page)).toBe(0);
	expect(await h.page.locator(overlayOf(paragraph)).getAttribute('data-tf-level')).toBe('1');
	await expect(h.page.locator(overlayOf(paragraph))).toBeVisible();
	expect(errors(h)).toEqual([]);
});

test('lane 8: two paragraphs tried 500 ms apart both end at their levels', async ({ h }) => {
	const png = await fresh('p4-two');
	await h.navigate(fixtures.wiki);
	await h.page.locator(nth(wikiParagraphs, 1)).evaluate((el) => el.scrollIntoView({ block: 'start' }));
	const idOf = (index: number) =>
		h.inContent<string>(`globalThis.__tfold.blockAt(document.querySelectorAll(${JSON.stringify(wikiParagraphs)})[${index}]).id`);
	const ids = [await idOf(1), await idOf(2)];
	await record(h.page);
	await foldBy(h, nth(wikiParagraphs, 1), 1);
	await h.page.waitForTimeout(500);
	await foldBy(h, nth(wikiParagraphs, 2), 2);
	await settle(h.page);
	const frames = await recorded(h.page);
	await h.page.screenshot({ path: png });
	const blocks = await h.readBlocks();
	const level = (id: string | undefined) => blocks.find((block) => block.id === id)?.level;
	console.log(`levels ${level(ids[0])} and ${level(ids[1])}; ${morphing(frames).length} frames with ghosts`);
	expect([level(ids[0]), level(ids[1])]).toEqual([1, 2]);
	expect(blocks.filter((block) => !ids.includes(block.id)).every((block) => block.level === 0)).toBe(true);
	expect(await leftovers(h.page)).toBe(0);
	expect(await hiddenRanges(h.page)).toBe(0);
	expect(errors(h)).toEqual([]);
});

test('lane 9: React keeps working after a morph, and the counter updates', async ({ h }) => {
	const png = await fresh('p4-react');
	await h.navigate(fixtures.react);
	const counter = h.page.locator('#counter');
	await expect(counter).toHaveText('0');
	await record(h.page);
	await foldBy(h, '#counter-paragraph', 2);
	await settle(h.page);
	await h.page.waitForTimeout(latchMs);
	await foldBy(h, overlayOf('#counter-paragraph'), -2);
	await settle(h.page);
	const frames = await recorded(h.page);
	await expect(counter).toBeVisible();
	await h.click('#counter');
	await expect(counter).toHaveText('1');
	await h.page.screenshot({ path: png });
	console.log(`${morphing(frames).length} frames with ghosts over the fold and the unfold`);
	expect(frames.some((frame) => frame.ghosts.some((ghost) => ghost.kind === 'move'))).toBe(true);
	expect(await leftovers(h.page)).toBe(0);
	expect(errors(h)).toEqual([]);
});

test('lane 10: an arXiv morph moves each formula whole and never splits it into words', async ({ h }) => {
	test.setTimeout(120_000);
	const png = await fresh('p4-arxiv');
	await h.navigate(fixtures.arxiv);
	const paragraph = h.page.locator(arxivFormulas);
	await paragraph.evaluate((el) => {
		el.scrollIntoView({ block: 'start' });
		scrollBy(0, -160);
	});
	const snapshot = await paragraph.evaluate((el) => el.outerHTML);
	const { formulas, mathOnly } = await paragraph.evaluate((el) => {
		const pieces = (text: string) => text.match(/[\p{L}\p{N}]+|\S/gu) ?? [];
		const formulas = [...el.querySelectorAll('math')].map((math) => math.textContent ?? '');
		const prose = el.cloneNode(true) as Element;
		for (const math of prose.querySelectorAll('math')) math.remove();
		const outside = new Set(pieces(prose.textContent ?? ''));
		return { formulas, mathOnly: [...new Set(formulas.flatMap(pieces))].filter((piece) => !outside.has(piece)) };
	});
	await record(h.page);
	await foldBy(h, arxivFormulas, 1);
	await freeze(h.page, 70);
	await h.page.screenshot({ path: png });
	const midway = await paragraph.evaluate((el) => {
		const copy = el.cloneNode(true) as Element;
		copy.removeAttribute('data-tfold-hidden');
		return copy.outerHTML;
	});
	await thaw(h.page);
	const frames = morphing(await recorded(h.page));
	await h.page.waitForTimeout(latchMs);
	await foldBy(h, overlayOf(arxivFormulas), -1);
	await settle(h.page);
	const restored = await paragraph.evaluate((el) => el.outerHTML);
	await h.page.waitForTimeout(latchMs);
	const adjoining = h.page.locator('[id="S2.SS1.p2.1"]');
	await adjoining.evaluate((el) => {
		el.scrollIntoView({ block: 'start' });
		scrollBy(0, -160);
	});
	await record(h.page);
	await foldBy(h, '[id="S2.SS1.p2.1"]', 1);
	await settle(h.page);
	const suffixes = (morphing(await recorded(h.page))[0]?.ghosts ?? []).map((ghost) => ghost.text).filter((text) => /^-(dimensional|th)$/.test(text));
	const ghosts = frames[0]?.ghosts ?? [];
	const holders = ghosts.filter((ghost) => ghost.formulas.length > 0);
	const pieces = ghosts.filter((ghost) => ghost.formulas.length === 0 && mathOnly.includes(ghost.text));
	console.log(`formulas: ${JSON.stringify(formulas)}; pieces only formulas have: ${JSON.stringify(mathOnly)}`);
	console.log(`ghosts at the start: ${ghosts.length}; holding a formula: ${JSON.stringify(holders.map((ghost) => ghost.formulas))}`);
	expect(formulas.length).toBe(3);
	expect(holders.map((ghost) => ghost.formulas)).toEqual(formulas.map((formula) => [formula]));
	console.log(`prose glued to a formula in S2.SS1.p2.1 that kept a ghost of its own: ${JSON.stringify(suffixes)}`);
	expect(pieces).toEqual([]);
	expect(suffixes).toContain('-dimensional');
	expect(midway).toBe(snapshot);
	expect(restored).toBe(snapshot);
	expect(errors(h)).toEqual([]);
});

test('lane 13: the ghosts paint above an opaque positioned container around the paragraph', async ({ h }) => {
	const png = await fresh('p4-stacking');
	const paragraph = await target(h, fixtures.wiki, 1);
	await h.page.locator(paragraph).evaluate((el) => {
		let container = el;
		while (container.parentElement && container.parentElement !== document.body) container = container.parentElement;
		if (container instanceof HTMLElement) container.style.cssText += ';position:relative;z-index:1;background:#fff';
	});
	await foldBy(h, paragraph, 1);
	await freeze(h.page, 80);
	const box = await h.page.evaluate(() => {
		const rects = [...document.querySelectorAll('tfold-ghosts [data-tf-ghost="move"]')].map((el) => {
			const range = document.createRange();
			range.selectNodeContents(el);
			return range.getBoundingClientRect();
		});
		const [left, top] = [Math.min(...rects.map((rect) => rect.left)), Math.min(...rects.map((rect) => rect.top))];
		return { x: left, y: top, width: Math.max(...rects.map((rect) => rect.right)) - left, height: Math.max(...rects.map((rect) => rect.bottom)) - top };
	});
	const withGhosts = await h.page.screenshot({ clip: box, path: png });
	await h.page.addStyleTag({ content: 'tfold-ghosts{visibility:hidden!important}' });
	const withoutGhosts = await h.page.screenshot({ clip: box });
	await thaw(h.page);
	console.log(`a paused morph under a z-index 1 container: ${withGhosts.equals(withoutGhosts) ? 'the ghosts are hidden under it' : 'the ghosts paint above it'}`);
	expect(withGhosts.equals(withoutGhosts)).toBe(false);
	expect(errors(h)).toEqual([]);
});

type TraceEvent = { name: string; cat: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: { data?: { type?: string } } };
type Sample = { inputToLastFrameMs: number; longestFrameMs: number; longestTaskMs: number; frames: number; ghostsGoneMs: number };

async function traced(page: Page, run: () => Promise<void>): Promise<TraceEvent[]> {
	const cdp = await page.context().newCDPSession(page);
	const events: TraceEvent[] = [];
	cdp.on('Tracing.dataCollected', ({ value }) => events.push(...(value as unknown as TraceEvent[])));
	const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
	await cdp.send('Tracing.start', {
		transferMode: 'ReportEvents',
		traceConfig: {
			includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'toplevel'],
		},
	});
	await run();
	await cdp.send('Tracing.end');
	await complete;
	await cdp.detach();
	return events;
}

function frameTimes(events: TraceEvent[]): Omit<Sample, 'ghostsGoneMs'> {
	const wheels = events.filter((event) => event.name === 'EventDispatch' && event.args?.data?.type === 'wheel');
	const last = wheels.at(-1);
	if (!last) throw new Error('the trace holds no wheel event');
	const input = last.ts;
	const draws = events
		.filter((event) => event.name === 'DrawFrame' && event.pid === last.pid && event.ts > input)
		.map((event) => event.ts)
		.sort((a, b) => a - b);
	const marks = [input, ...draws];
	const gaps = marks.slice(1).map((ts, i) => ts - (marks[i] ?? ts));
	const tasks = events.filter(
		(event) => event.name === 'RunTask' && event.pid === last.pid && event.tid === last.tid && event.ts + (event.dur ?? 0) >= input && event.ts <= (draws.at(-1) ?? input),
	);
	const longest = tasks.reduce<TraceEvent | undefined>((best, task) => ((task.dur ?? 0) > (best?.dur ?? 0) ? task : best), undefined);
	if (longest && process.env.TFOLD_BREAKDOWN) {
		const inside = events.filter((event) => event.tid === longest.tid && event.pid === longest.pid && event.dur !== undefined && event.ts >= longest.ts && event.ts + (event.dur ?? 0) <= longest.ts + (longest.dur ?? 0) && event !== longest);
		const sums = new Map<string, number>();
		for (const event of inside) sums.set(event.name, (sums.get(event.name) ?? 0) + (event.dur ?? 0) / 1000);
		console.log(`breakdown ${((longest.ts - input) / 1000).toFixed(1)} ms after input, ${((longest.dur ?? 0) / 1000).toFixed(1)} ms: ${JSON.stringify([...sums].filter(([, ms]) => ms > 0.4).sort((a, b) => b[1] - a[1]).map(([name, ms]) => [name, Math.round(ms * 10) / 10]))}`);
		const firstTasks = tasks.filter((task) => (task.dur ?? 0) > 1000).map((task) => [((task.ts - input) / 1000).toFixed(1), ((task.dur ?? 0) / 1000).toFixed(1)]);
		console.log(`tasks over 1 ms (start after input, length): ${JSON.stringify(firstTasks)}; draws ${JSON.stringify(draws.slice(0, 4).map((ts) => ((ts - input) / 1000).toFixed(1)))}`);
	}
	return {
		inputToLastFrameMs: ((draws.at(-1) ?? input) - input) / 1000,
		longestFrameMs: Math.max(0, ...gaps) / 1000,
		longestTaskMs: Math.max(0, ...tasks.map((task) => task.dur ?? 0)) / 1000,
		frames: draws.length,
	};
}

test.describe('perf probe', () => {
	test.skip(process.env.TFOLD_PROBE !== 'perf', 'TFOLD_PROBE=perf runs the perf probe');
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	test('longest frame and morph length of Full to Brief over 20 morphs', async ({ headless }) => {
		test.setTimeout(900_000);
		const h = await launch({ headless, allowLiveHosts: ['127.0.0.1'] });
		const samples: Sample[] = [];
		try {
			const close = await mockProvider(h);
			const first = await target(h, fixtures.wiki, 1);
			await foldWithModel(h, first);
			await unfold(h, first);
			await close();
			await h.page.evaluate(() => {
				const stamps = { wheel: 0, gone: 0 };
				Object.assign(globalThis, { stamps });
				addEventListener('wheel', (event) => event.ctrlKey && (stamps.wheel = performance.now()), { capture: true, passive: true });
				new MutationObserver((records) => {
					if (records.some((record) => [...record.removedNodes].some((node) => node.nodeName === 'TFOLD-GHOSTS'))) stamps.gone = performance.now();
				}).observe(document.documentElement, { childList: true });
			});
			for (let round = -2; round < Number(process.env.TFOLD_ROUNDS ?? 20); round++) {
				const paragraph = '[data-p4-paragraph]';
				await h.page.evaluate(() => Object.assign((globalThis as unknown as { stamps: object }).stamps, { wheel: 0, gone: 0 }));
				const events = await traced(h.page, async () => {
					await foldBy(h, paragraph, 1);
					await h.page.waitForTimeout(900);
				});
				const stamps = await h.page.evaluate(() => (globalThis as unknown as { stamps: { wheel: number; gone: number } }).stamps);
				if (round === -2) {
					const names = new Map<string, number>();
					for (const event of events) names.set(event.name, (names.get(event.name) ?? 0) + 1);
					console.log(`trace event names: ${JSON.stringify([...names].filter(([name]) => /Frame|EventDispatch|RunTask|Animation/.test(name)))}`);
				}
				if (round >= 0) samples.push({ ...frameTimes(events), ghostsGoneMs: stamps.gone ? stamps.gone - stamps.wheel : 0 });
				await unfold(h, paragraph);
			}
		} finally {
			await h.close();
		}
		const pick = (values: number[], q: number) => values.toSorted((a, b) => a - b)[Math.ceil(q * values.length) - 1] ?? NaN;
		const describe = (values: number[]) =>
			`median ${pick(values, 0.5).toFixed(1)}, p95 ${pick(values, 0.95).toFixed(1)}, max ${Math.max(...values).toFixed(1)} ms`;
		const of = (key: keyof Sample) => samples.map((sample) => sample[key]);
		await mkdir(outDir, { recursive: true });
		await writeFile(path.join(outDir, 'perf.json'), JSON.stringify({ samples }, null, 1));
		console.log(`${of('frames').length} Full to Brief folds`);
		console.log(`  longest frame, input or previous frame to the next drawn frame: ${describe(of('longestFrameMs'))}`);
		console.log(`  longest main-thread task: ${describe(of('longestTaskMs'))}`);
		console.log(`  input to the last drawn frame: ${describe(of('inputToLastFrameMs'))}; frames drawn: ${describe(of('frames'))}`);
		console.log(`  step-completing wheel event to the ghost layer removed: ${describe(of('ghostsGoneMs'))}`);
		expect(of('frames')).toHaveLength(20);
		expect(Math.max(...of('longestFrameMs'))).toBeLessThanOrEqual(32);
		expect(Math.max(...of('ghostsGoneMs'))).toBeLessThanOrEqual(450);
		expect(Math.max(...of('inputToLastFrameMs'))).toBeLessThanOrEqual(450);
	});
});

async function presenter(h: Harness, started: number) {
	await h.page.setViewportSize({ width: 1280, height: 720 });
	await h.page.addInitScript(() => {
		addEventListener('DOMContentLoaded', () => {
			const dot = document.body.appendChild(document.createElement('div'));
			dot.id = 'tf-dot';
			dot.style.cssText =
				'position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(220,40,40,.45);border:2px solid #fff;pointer-events:none;z-index:2147483647;left:-50px;top:-50px';
			const caption = document.body.appendChild(document.createElement('div'));
			caption.id = 'tf-caption';
			caption.style.cssText =
				'position:fixed;left:16px;bottom:16px;max-width:900px;padding:8px 14px;border-radius:8px;background:rgba(20,20,20,.85);color:#fff;font:600 18px system-ui;pointer-events:none;z-index:2147483647';
			addEventListener('mousemove', (event) => {
				dot.style.left = `${event.clientX}px`;
				dot.style.top = `${event.clientY}px`;
			});
		});
	});
	const say = (text: string) =>
		h.page.evaluate((value) => {
			const caption = document.getElementById('tf-caption');
			if (caption) caption.textContent = value;
		}, text);
	const pointOver = (index: number) =>
		h.page.evaluate(
			({ selector, index }) => {
				const el = document.querySelectorAll(selector)[index];
				const shown = el?.checkVisibility() ? el : el?.nextElementSibling;
				const rect = shown?.getBoundingClientRect();
				if (!rect) throw new Error(`paragraph ${index} has no box`);
				return { x: rect.left + Math.min(rect.width / 2, 260), y: rect.top + Math.min(rect.height / 2, 24) };
			},
			{ selector: wikiParagraphs, index },
		);
	const step = async (index: number, steps: number, text: string, hold: number) => {
		const point = await pointOver(index);
		await h.page.mouse.move(point.x, point.y, { steps: 8 });
		await say(text);
		await h.page.waitForTimeout(500);
		console.log(`fold ${steps > 0 ? '+' : ''}${steps} on paragraph ${index} at ${((Date.now() - started) / 1000).toFixed(2)} s: ${text}`);
		await h.foldAt(point.x, point.y, steps);
		await h.page.waitForTimeout(hold);
	};
	const scrollTo = async (index: number) => {
		await h.page.locator(nth(wikiParagraphs, index)).evaluate((el) => {
			el.scrollIntoView({ block: 'start' });
			scrollBy(0, -140);
		});
		await h.page.waitForTimeout(800);
	};
	const waitForModel = (index: number) =>
		expect(h.page.locator(nth(wikiParagraphs, index)).locator('xpath=following-sibling::*[1][@data-tf-fold="model"]')).toHaveCount(1, {
			timeout: 30_000,
		});
	return { say, step, scrollTo, waitForModel };
}

async function encode(videoDir: string, mp4: string): Promise<void> {
	const [webm] = (await readdir(videoDir)).filter((name) => name.endsWith('.webm'));
	if (!webm) throw new Error('Playwright wrote no video');
	sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(videoDir, webm), '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
	const { size } = await stat(mp4);
	const seconds = Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]));
	console.log(`${path.basename(mp4)}: ${(size / 1e6).toFixed(2)} MB, ${seconds.toFixed(1)} s`);
	expect(size).toBeLessThan(5e6);
	expect(seconds).toBeGreaterThanOrEqual(30);
	expect(seconds).toBeLessThanOrEqual(60);
}

test.describe('video probe', () => {
	const key = process.env.OPENROUTER_API_KEY ?? '';
	test.skip(process.env.TFOLD_PROBE !== 'video', 'TFOLD_PROBE=video records the review videos');
	test.skip(key === '', 'OPENROUTER_API_KEY is not set');

	for (const { name, page, slug, paragraphs, words } of [
		{ name: 'English Wikipedia', page: fixtures.wiki, slug: 'p4-review', paragraphs: [1, 2, 3], words: 'English Wikipedia, Black hole' },
		{ name: 'Korean Wikipedia', page: koWiki, slug: 'p4-review-korean', paragraphs: [3, 4, 5], words: 'Korean Wikipedia, 블랙홀' },
	]) {
		test(`slow and fast folds through every level on ${name}`, async ({ headless }) => {
			test.setTimeout(300_000);
			const [first, second, third] = paragraphs as [number, number, number];
			const videoDir = path.join(outDir, `video-${slug}`);
			const mp4 = path.join(outDir, `${slug}.mp4`);
			await rm(videoDir, { recursive: true, force: true });
			await rm(mp4, { force: true });
			const h = await launch({ headless, allowLiveHosts: ['openrouter.ai'], recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
			const started = Date.now();
			try {
				await h.worker.evaluate((apiKey) => chrome.storage.local.set({ provider: { apiKey } }), key);
				const { say, step, scrollTo, waitForModel } = await presenter(h, started);
				await h.navigate(page);
				await scrollTo(first);
				await say(`${words}: fold over a paragraph`);
				await h.page.waitForTimeout(1500);
				await step(first, 1, 'First how: the local fold shows at once, then the model fold slides in', 200);
				await waitForModel(first);
				await h.page.waitForTimeout(1800);
				await step(first, -1, 'Back to Full: the kept sentences slide back, then the rest fades in', 2000);
				await step(first, 1, 'Slowly to Brief: the rest fades, then the kept sentences slide row by row', 2200);
				await step(first, 1, 'Key: words the model reused slide, its own words fade in', 2200);
				await step(first, 1, 'Takeaway: the headline keeps the Key words it shares', 2200);
				await step(first, -2, 'Back to Brief, two levels in one fold', 2200);
				await step(first, -1, 'Back to Full', 2000);
				await step(first, 3, 'Fast fold, through every level at once', 1600);
				await step(first, -3, 'Fast unfold, back to Full', 2000);
				await step(second, 1, 'The next paragraph: folded by the same call, so it slides at once', 2200);
				await step(second, 1, 'Key', 2000);
				await step(second, -2, 'Back to Full', 2200);
				await step(third, 2, 'A third paragraph, two levels in one fold', 2200);
				await step(third, -2, 'Back to Full', 2200);
				await say('Each paragraph keeps its own level, and the page itself never changes');
				await h.page.waitForTimeout(1500);
				const calls = h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('fold usage '));
				const cost = calls.reduce((sum, entry) => sum + ((JSON.parse(entry.text.slice('fold usage '.length)) as { cost?: number }).cost ?? 0), 0);
				console.log(`${name}: ${calls.length} OpenRouter calls, $${cost.toFixed(6)}`);
				expect(errors(h)).toEqual([]);
			} finally {
				await h.close();
			}
			await encode(videoDir, mp4);
		});
	}
});
