import { spawnSync } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { fixtures, launch, type BlockState, type Harness, type Point } from '../harness.ts';
import { expect, test } from '../lane.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p2');
const latchMs = 400;
const wikiParagraphs = '#mw-content-text section > p:not(.mw-empty-elt):not([data-tfold-overlay])';
const secondParagraphBrief =
	'Objects whose gravitational fields are too strong for light to escape were first considered in the 18th century.';

const nth = (selector: string, index: number) => `${selector} >> nth=${index}`;

async function fresh(slug: string): Promise<string> {
	const file = path.join(outDir, `${slug}.png`);
	await rm(file, { force: true });
	return file;
}

function sh(command: string, args: string[], cwd = repoRoot): string {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr}`);
	return result.stdout.trim();
}

const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const folded = (blocks: BlockState[]) => blocks.filter((block) => block.level !== 0);

function idOf(h: Harness, selector: string, index: number): Promise<string> {
	return h.inContent<string>(
		`globalThis.__tfold.blockAt(document.querySelectorAll(${JSON.stringify(selector)})[${index}]).id`,
	);
}

async function levelOf(h: Harness, id: string): Promise<number | undefined> {
	return (await h.readBlocks()).find((block) => block.id === id)?.level;
}

async function frames(page: Page, count = 2): Promise<void> {
	for (let i = 0; i < count; i++) await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

type Shown = { hidden: boolean; overlayLevel: string | null; overlayText: string | null; top: number; height: number };

function shown(page: Page, selector: string, index: number): Promise<Shown> {
	return page.evaluate(
		({ selector, index }) => {
			const el = document.querySelectorAll(selector)[index];
			if (!el) throw new Error(`no element ${index} for ${selector}`);
			const next = el.nextElementSibling;
			const overlay = next?.hasAttribute('data-tfold-overlay') ? next : null;
			const rect = (el.checkVisibility() ? el : (overlay ?? el)).getBoundingClientRect();
			return {
				hidden: !el.checkVisibility(),
				overlayLevel: overlay?.getAttribute('data-tf-level') ?? null,
				overlayText: overlay?.textContent ?? null,
				top: rect.top,
				height: rect.height,
			};
		},
		{ selector, index },
	);
}

async function foldBy(h: Harness, selector: string, steps: number): Promise<Point> {
	const point = await h.pointAt(selector);
	await h.foldAt(point.x, point.y, steps);
	return point;
}

async function sideBySide(page: Page, file: string, shots: { label: string; png: Buffer }[]): Promise<void> {
	const figures = shots
		.map(({ label, png }) => `<figure><figcaption>${label}</figcaption><img src="data:image/png;base64,${png.toString('base64')}"></figure>`)
		.join('');
	await page.setContent(
		`<style>body{margin:0;background:#444;font:600 18px system-ui;color:#fff}figure{margin:0 0 8px}figcaption{padding:6px 10px}img{display:block}</style>${figures}`,
	);
	await page.locator('body').screenshot({ path: file });
}

test('lane 1: a fold over the second paragraph folds it to Brief and leaves its neighbors alone', async ({ h }) => {
	const png = await fresh('p2-brief');
	const target = nth(wikiParagraphs, 1);
	await h.navigate(fixtures.wiki);
	await foldBy(h, target, 1);
	await frames(h.page);
	const id = await idOf(h, wikiParagraphs, 1);
	const blocks = await h.readBlocks();
	const [previous, paragraph, next] = await Promise.all([0, 1, 2].map((index) => shown(h.page, wikiParagraphs, index)));
	const overlays = await h.page.locator('[data-tfold-overlay]').count();
	await h.page.screenshot({ path: png });
	expect(folded(blocks)).toEqual([{ id, level: 1 }]);
	expect(paragraph).toMatchObject({ hidden: true, overlayLevel: '1', overlayText: secondParagraphBrief });
	expect([previous?.hidden, previous?.overlayLevel, next?.hidden, next?.overlayLevel]).toEqual([false, null, false, null]);
	expect(overlays).toBe(1);
});

test('lane 2: three steps in and three steps out restore the paragraph exactly', async ({ h }) => {
	const png = await fresh('p2-roundtrip');
	const target = nth(wikiParagraphs, 1);
	await h.navigate(fixtures.wiki);
	const snapshot = await h.page.locator(target).evaluate((el) => el.outerHTML);
	const id = await idOf(h, wikiParagraphs, 1);
	await foldBy(h, target, 3);
	expect(folded(await h.readBlocks())).toEqual([{ id, level: 3 }]);
	await foldBy(h, '[data-tfold-overlay]', -3);
	await frames(h.page);
	const restored = await h.page.locator(target).evaluate((el) => el.outerHTML);
	const left = await h.page.locator('[data-tfold-overlay], [data-tfold-hidden]').count();
	const blocks = await h.readBlocks();
	await h.page.screenshot({ path: png });
	expect(blocks.length).toBeGreaterThan(1);
	expect(folded(blocks)).toEqual([]);
	expect(restored).toBe(snapshot);
	expect(left).toBe(0);
});

test('lane 3: paragraphs 2 and 5 keep their own levels', async ({ h }) => {
	const png = await fresh('p2-independent');
	await h.navigate(fixtures.wiki);
	const [secondId, fifthId] = [await idOf(h, wikiParagraphs, 1), await idOf(h, wikiParagraphs, 4)];
	await foldBy(h, nth(wikiParagraphs, 1), 1);
	await h.page.waitForTimeout(latchMs + 100);
	await foldBy(h, nth(wikiParagraphs, 4), 3);
	await frames(h.page);
	const [second, fifth] = [await shown(h.page, wikiParagraphs, 1), await shown(h.page, wikiParagraphs, 4)];
	const blocks = await h.readBlocks();
	await h.page.setViewportSize({ width: 1280, height: Math.ceil(fifth.top + fifth.height - second.top + 80) });
	await h.page.locator(nth(wikiParagraphs, 1)).evaluate((el) => el.nextElementSibling?.scrollIntoView({ block: 'start' }));
	await h.page.evaluate(() => scrollBy(0, -40));
	await h.page.screenshot({ path: png });
	expect(blocks.find((block) => block.id === secondId)?.level).toBe(1);
	expect(blocks.find((block) => block.id === fifthId)?.level).toBe(3);
	expect(blocks.filter((block) => block.id !== secondId && block.id !== fifthId).every((block) => block.level === 0)).toBe(
		true,
	);
	expect([second.overlayLevel, fifth.overlayLevel]).toEqual(['1', '3']);
});

test('lane 4: React keeps the folded counter paragraph current, and unfolding shows the new count', async ({ h }) => {
	const png = await fresh('p2-react');
	await h.navigate(fixtures.react);
	const counter = h.page.locator('#counter');
	const overlay = h.page.locator('#counter-paragraph + [data-tfold-overlay]');
	await expect(counter).toHaveText('0');
	await foldBy(h, '#counter-paragraph', 1);
	await expect(h.page.locator('#counter-paragraph')).toBeHidden();
	await expect(overlay).toContainText('reads 0 clicks');
	console.log('the folded counter is hidden, so the lane clicks it with a DOM click, as a page script would');
	await counter.dispatchEvent('click');
	await expect(overlay).toContainText('reads 1 clicks');
	const foldedShot = await h.page.screenshot();
	await foldBy(h, '#counter-paragraph + [data-tfold-overlay]', -1);
	await expect(counter).toBeVisible();
	await expect(counter).toHaveText('1');
	const restoredShot = await h.page.screenshot();
	const blocks = await h.readBlocks();
	await sideBySide(h.page, png, [
		{ label: 'folded to Brief, then the counter clicked', png: foldedShot },
		{ label: 'unfolded: the counter reads 1', png: restoredShot },
	]);
	expect(blocks).toHaveLength(3);
	expect(folded(blocks)).toEqual([]);
	expect(errors(h)).toEqual([]);
});

test('lane 5: a client-side round trip brings each React paragraph back at its level', async ({ h }) => {
	const png = await fresh('p2-spa');
	const paragraphs = 'article > p:not([data-tfold-overlay])';
	await h.navigate(fixtures.react);
	await expect(h.page.locator('#counter')).toHaveText('0');
	await foldBy(h, nth(paragraphs, 0), 2);
	await h.page.waitForTimeout(latchMs + 100);
	await foldBy(h, '#counter-paragraph', 1);
	const before = folded(await h.readBlocks());
	expect(before.map((block) => block.level).toSorted()).toEqual([1, 2]);
	await h.click('nav a[href="/react/about"]');
	await expect(h.page.locator('h1')).toHaveText('A second route');
	const away = await h.readBlocks();
	expect(away.map((block) => block.level)).toEqual([0]);
	await h.click('nav a[href="/react/"]');
	await expect(h.page.locator('h1')).toHaveText('A page that React owns');
	await expect(h.page.locator('[data-tfold-overlay]')).toHaveCount(2);
	const overlayLevels = await Promise.all([0, 1, 2].map(async (index) => (await shown(h.page, paragraphs, index)).overlayLevel));
	const back = folded(await h.readBlocks());
	await h.page.screenshot({ path: png });
	expect(overlayLevels).toEqual(['2', '1', null]);
	expect(back).toEqual(before);
	expect(errors(h)).toEqual([]);
});

test('lane 6: folding the paragraph nearest the viewport center keeps its top in place', async ({ h }) => {
	const png = await fresh('p2-scroll-center');
	await h.navigate(fixtures.wiki);
	await h.page.evaluate(() => scrollTo(0, 2400));
	const index = await h.page.evaluate((selector) => {
		const middle = innerHeight / 2;
		const inView = [...document.querySelectorAll(selector)]
			.map((el, i) => ({ i, rect: el.getBoundingClientRect() }))
			.filter(({ rect }) => rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight);
		inView.sort((a, b) => Math.abs((a.rect.top + a.rect.bottom) / 2 - middle) - Math.abs((b.rect.top + b.rect.bottom) / 2 - middle));
		return inView[0]?.i ?? -1;
	}, wikiParagraphs);
	expect(index).toBeGreaterThanOrEqual(0);
	const before = await shown(h.page, wikiParagraphs, index);
	await foldBy(h, nth(wikiParagraphs, index), 1);
	await frames(h.page);
	const after = await shown(h.page, wikiParagraphs, index);
	console.log(`paragraph ${index}: top ${before.top} -> ${after.top}, height ${before.height} -> ${after.height}`);
	await h.page.screenshot({ path: png });
	expect(after.overlayLevel).toBe('1');
	expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(2);
});

test('lane 7: setLevel on a paragraph above the viewport leaves the first visible paragraph in place', async ({ h }) => {
	const png = await fresh('p2-scroll-above');
	await h.navigate(fixtures.wiki);
	await h.page.evaluate(() => scrollTo(0, 3000));
	const { above, firstVisible } = await h.page.evaluate((selector) => {
		const rects = [...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect());
		return {
			above: rects.findLastIndex((rect) => rect.height > 0 && rect.bottom < 0),
			firstVisible: rects.findIndex((rect) => rect.height > 0 && rect.top >= 0),
		};
	}, wikiParagraphs);
	expect(above).toBeGreaterThanOrEqual(0);
	expect(firstVisible).toBeGreaterThan(above);
	const [aboveBefore, visibleBefore] = [await shown(h.page, wikiParagraphs, above), await shown(h.page, wikiParagraphs, firstVisible)];
	const id = await idOf(h, wikiParagraphs, above);
	await h.inContent(`globalThis.__tfold.setLevel(${JSON.stringify(id)}, 1)`);
	await frames(h.page);
	const [aboveAfter, visibleAfter] = [await shown(h.page, wikiParagraphs, above), await shown(h.page, wikiParagraphs, firstVisible)];
	console.log(
		`paragraph ${above} above the viewport: height ${aboveBefore.height} -> ${aboveAfter.height}; first visible paragraph ${firstVisible}: top ${visibleBefore.top} -> ${visibleAfter.top}`,
	);
	await h.page.screenshot({ path: png });
	expect(await levelOf(h, id)).toBe(1);
	expect(aboveAfter.height).toBeLessThan(aboveBefore.height);
	expect(Math.abs(visibleAfter.top - visibleBefore.top)).toBeLessThanOrEqual(2);
});

test('lane 8: four quick folds stay latched to the paragraph they started on', async ({ h }) => {
	const png = await fresh('p2-latch');
	const target = nth(wikiParagraphs, 1);
	await h.navigate(fixtures.wiki);
	const id = await idOf(h, wikiParagraphs, 1);
	await h.pointAt(target);
	const point = await h.page.locator(target).evaluate((el) => {
		const range = document.createRange();
		range.selectNodeContents(el);
		const last = [...range.getClientRects()].filter((rect) => rect.width > 0).at(-1);
		if (!last) throw new Error('the paragraph has no text box');
		return { x: last.left + 2, y: last.top + last.height / 2 };
	});
	await h.foldAt(point.x, point.y, 1);
	const underPointer = await h.page.evaluate(({ x, y }) => {
		const hit = document.elementFromPoint(x, y);
		return hit?.closest('[data-tfold-overlay]') ? 'the overlay' : (hit?.closest('p')?.textContent ?? '').slice(0, 60);
	}, point);
	console.log(`after the first step the pointer is over: ${underPointer}`);
	for (let i = 0; i < 3; i++) await h.foldAt(point.x, point.y, 1);
	await frames(h.page);
	await h.page.screenshot({ path: png });
	expect(underPointer).not.toBe('the overlay');
	expect(folded(await h.readBlocks())).toEqual([{ id, level: 3 }]);
});

test('lane 9: a fold over a figure caption or the navigation changes no block and is not cancelled', async ({ h }) => {
	const png = await fresh('p2-skip');
	await h.navigate(fixtures.wiki);
	await h.page.evaluate(() => {
		const log = { where: '', wheels: [] as { where: string; prevented: boolean }[] };
		Object.assign(globalThis, { wheelLog: log });
		addEventListener('wheel', (event) => {
			if (event.ctrlKey) log.wheels.push({ where: log.where, prevented: event.defaultPrevented });
		});
	});
	const foldOver = async (where: string, selector: string) => {
		await h.page.evaluate((name) => ((globalThis as unknown as { wheelLog: { where: string } }).wheelLog.where = name), where);
		await foldBy(h, selector, 1);
		await h.page.waitForTimeout(latchMs + 100);
	};
	const navLink = await h.page.evaluate(() => {
		const links = [...document.querySelectorAll('nav a')];
		return links.findIndex((link) => {
			const rect = link.getBoundingClientRect();
			return rect.width > 0 && rect.top >= 0 && rect.bottom <= innerHeight && link.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
		});
	});
	expect(navLink).toBeGreaterThanOrEqual(0);
	await foldOver('nav', nth('nav a', navLink));
	await foldOver('caption', '#mw-content-text figure figcaption');
	await h.page.screenshot({ path: png });
	const blocks = await h.readBlocks();
	await foldOver('paragraph', nth(wikiParagraphs, 1));
	const wheels = await h.page.evaluate(() => (globalThis as unknown as { wheelLog: { wheels: { where: string; prevented: boolean }[] } }).wheelLog.wheels);
	const summary = new Map<string, number>();
	for (const { where, prevented } of wheels) {
		const key = `${where} prevented ${prevented}`;
		summary.set(key, (summary.get(key) ?? 0) + 1);
	}
	console.log([...summary].map(([key, count]) => `${key}: ${count} wheel events`).join(', '));
	expect(folded(blocks)).toEqual([]);
	expect([...summary.keys()].toSorted()).toEqual(['caption prevented false', 'nav prevented false', 'paragraph prevented true']);
});

test('lane 10: a formula paragraph on arXiv renders its formulas again after unfold', async ({ h }) => {
	const png = await fresh('p2-arxiv');
	const target = '[id="S2.SS1.p1.1"]';
	await h.navigate(fixtures.arxiv);
	const paragraph = h.page.locator(target);
	const formulasShown = () => paragraph.locator('math').evaluateAll((all) => all.map((math) => math.checkVisibility() && math.getBoundingClientRect().width > 0));
	const snapshot = await paragraph.evaluate((el) => el.outerHTML);
	expect(await formulasShown()).toEqual([true, true, true]);
	await foldBy(h, target, 1);
	await expect(paragraph).toBeHidden();
	expect(await formulasShown()).toEqual([false, false, false]);
	await foldBy(h, `${target} + [data-tfold-overlay]`, -1);
	await expect(paragraph).toBeVisible();
	const restored = await paragraph.evaluate((el) => el.outerHTML);
	await paragraph.evaluate((el) => el.scrollIntoView({ block: 'center' }));
	await h.page.screenshot({ path: png });
	expect(await formulasShown()).toEqual([true, true, true]);
	expect(restored).toBe(snapshot);
	expect(errors(h)).toEqual([]);
});

test.describe('perf probe', () => {
	test.skip(process.env.TFOLD_PROBE !== 'perf', 'TFOLD_PROBE=perf runs the perf probe');

	test('fold to paint p95 over 50 folds', async ({ headless }) => {
		test.setTimeout(300_000);
		const h = await launch({ headless });
		try {
			type Stamps = { first: number; step: number; dispatched: number; mutated: number; frame: number };
			await h.page.addInitScript(() => {
				const stamps = { first: 0, step: 0, dispatched: 0, mutated: 0, frame: 0 };
				Object.assign(globalThis, { stamps });
				addEventListener(
					'wheel',
					(event) => {
						if (!event.ctrlKey) return;
						if (!stamps.first) stamps.first = event.timeStamp;
						stamps.step = event.timeStamp;
						stamps.dispatched = performance.now();
					},
					{ capture: true, passive: true },
				);
			});
			await h.navigate(fixtures.wiki);
			await h.page.evaluate(() => {
				const { stamps } = globalThis as unknown as { stamps: Stamps };
				new MutationObserver(() => {
					if (stamps.mutated || !stamps.first) return;
					stamps.mutated = performance.now();
					requestAnimationFrame(() => (stamps.frame = performance.now()));
				}).observe(document.documentElement, { subtree: true, attributeFilter: ['data-tfold-hidden'] });
			});
			const samples: Stamps[] = [];
			for (let i = 0; i < 25; i++) {
				for (const [selector, steps] of [
					[nth(wikiParagraphs, i % 10), 1],
					['[data-tfold-overlay]', -1],
				] as const) {
					const point = await h.pointAt(selector);
					await h.page.evaluate(() =>
						Object.assign((globalThis as unknown as { stamps: Stamps }).stamps, { first: 0, step: 0, dispatched: 0, mutated: 0, frame: 0 }),
					);
					await h.foldAt(point.x, point.y, steps);
					await h.page.waitForFunction(() => (globalThis as unknown as { stamps: Stamps }).stamps.frame > 0);
					samples.push(await h.page.evaluate(() => ({ ...(globalThis as unknown as { stamps: Stamps }).stamps })));
					await h.page.waitForTimeout(latchMs + 50);
				}
			}

			const pick = (values: number[], q: number) => values.toSorted((a, b) => a - b)[Math.ceil(q * values.length) - 1] ?? NaN;
			const describe = (values: number[]) =>
				`median ${pick(values, 0.5).toFixed(1)} ms, p95 ${pick(values, 0.95).toFixed(1)} ms, range ${Math.min(...values).toFixed(1)} to ${Math.max(...values).toFixed(1)} ms`;
			const stepToPaint = samples.map((s) => s.frame - s.step);
			console.log(`step-completing wheel event to rAF paint stamp, ${samples.length} folds: ${describe(stepToPaint)}`);
			console.log(`  input delay, wheel event created to dispatched: ${describe(samples.map((s) => s.dispatched - s.step))}`);
			console.log(`  content script handler, dispatched to DOM changed: ${describe(samples.map((s) => s.mutated - s.dispatched))}`);
			console.log(`  wait for the frame, DOM changed to rAF stamp: ${describe(samples.map((s) => s.frame - s.mutated))}`);
			console.log(`  first fold on the page, which runs the first block scan: ${stepToPaint[0]?.toFixed(1)} ms`);
			console.log(`first of six foldAt wheel events to rAF paint stamp: ${describe(samples.map((s) => s.frame - s.first))}`);
			console.log(`  foldAt pacing, first to sixth wheel event: ${describe(samples.map((s) => s.step - s.first))}`);
			expect(samples).toHaveLength(50);
			expect(pick(stepToPaint, 0.95)).toBeLessThanOrEqual(50);
		} finally {
			await h.close();
		}
	});
});

test.describe('video probe', () => {
	test.skip(process.env.TFOLD_PROBE !== 'video', 'TFOLD_PROBE=video records the review video');

	test('fold three paragraphs on the Wikipedia fixture', async ({ headless }) => {
		test.setTimeout(300_000);
		const videoDir = path.join(outDir, 'video');
		const mp4 = path.join(outDir, 'p2-review.mp4');
		await rm(videoDir, { recursive: true, force: true });
		await rm(mp4, { force: true });
		const h = await launch({ headless, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
		try {
			await h.navigate(fixtures.wiki);
			await h.page.evaluate(() => {
				const dot = document.body.appendChild(document.createElement('div'));
				dot.style.cssText =
					'position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(220,40,40,.55);border:2px solid #fff;pointer-events:none;z-index:2147483647;left:-50px;top:-50px';
				const caption = document.body.appendChild(document.createElement('div'));
				caption.id = 'tf-caption';
				caption.style.cssText =
					'position:fixed;left:16px;bottom:16px;padding:8px 14px;border-radius:8px;background:rgba(20,20,20,.85);color:#fff;font:600 18px system-ui;pointer-events:none;z-index:2147483647';
				addEventListener('mousemove', (event) => {
					dot.style.left = `${event.clientX}px`;
					dot.style.top = `${event.clientY}px`;
				});
			});
			const say = (text: string) => h.page.evaluate((value) => ((document.getElementById('tf-caption') as HTMLElement).textContent = value), text);
			const step = async (index: number, steps: number, text: string) => {
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
				await say(text);
				await h.page.mouse.move(point.x, point.y, { steps: 12 });
				await h.page.waitForTimeout(800);
				await h.foldAt(point.x, point.y, steps);
				await h.page.waitForTimeout(1800);
			};
			const [first, second, third] = [22, 23, 24];
			await say('tfold: fold over a paragraph to shorten it in place');
			await h.page.locator(nth(wikiParagraphs, first)).evaluate((el) => el.scrollIntoView({ block: 'start' }));
			await h.page.evaluate(() => scrollBy(0, -60));
			await h.page.waitForTimeout(2000);
			await step(first, 1, 'First paragraph: fold to Brief, its first sentence');
			await step(first, 1, 'First paragraph: fold to Key, the first 22 words');
			await step(first, 1, 'First paragraph: fold to Takeaway, the first 14 words');
			await step(second, 1, 'Second paragraph: fold to Brief');
			await step(second, 1, 'Second paragraph: fold to Key');
			await step(third, 1, 'Third paragraph: fold to Brief');
			await say('Each paragraph keeps its own level');
			await h.page.waitForTimeout(2500);
			await step(first, -1, 'First paragraph: unfold to Key');
			await step(first, -1, 'First paragraph: unfold to Brief');
			await step(first, -1, 'First paragraph: unfold to Full');
			await step(second, -2, 'Second paragraph: unfold two steps to Full');
			await step(third, -1, 'Third paragraph: unfold to Full');
			await say('Every paragraph is back at Full');
			await h.page.waitForTimeout(2500);
			expect(folded(await h.readBlocks())).toEqual([]);
		} finally {
			await h.close();
		}
		const [webm] = (await readdir(videoDir)).filter((name) => name.endsWith('.webm'));
		if (!webm) throw new Error('Playwright wrote no video');
		sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(videoDir, webm), '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
		const { size } = await stat(mp4);
		const seconds = Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]));
		console.log(`p2-review.mp4: ${(size / 1e6).toFixed(2)} MB, ${seconds.toFixed(1)} s`);
		expect(size).toBeLessThan(5e6);
		expect(seconds).toBeGreaterThanOrEqual(30);
		expect(seconds).toBeLessThanOrEqual(60);
	});
});
