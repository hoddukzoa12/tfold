import { appendFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test, type CDPSession, type Page } from '@playwright/test';
import { extensionDir, launch, type Harness } from '../harness.ts';

// TFOLD_PROBE=scroll folds a page and measures it while it scrolls and the page's own scripts write to it, one side
// after another. TFOLD_SCROLL_SIDES names the sides as name=dist,name=dist, TFOLD_SCROLL_SCENARIOS picks scenarios by
// name, TFOLD_SCROLL_RUNS sets the runs per side, and TFOLD_SCROLL_MODE=count or profile takes the runs that are not
// reported: one counts the style reads of the content script and one samples the main thread.

type Actor = 'none' | 'constant' | 'typical' | 'text-per-frame' | 'text-5' | 'attribute-on-html';
type Scenario = { name: string; page: 'x' | 'threads' | 'feed' | 'wiki'; actor: Actor; cpu: number; folds?: number; level?: number };
type Mode = 'timed' | 'count' | 'profile';
type Written = { rows: number; hover: number; text: number; html: number };
type Seen = { frames: number[]; long: number[]; attrs: number; childs: number; chars: number; scrolled: number; elapsed: number; written: Written };
type Row = { scenario: string; side: string; mode: Mode; folds: number; overlays: number; local: number; errors: string[] } & Record<NumericColumn, number>;
type NumericColumn = (typeof columns)[number];

const scenarios: Scenario[] = [
	{ name: 'x-typical', page: 'x', actor: 'typical', cpu: 1 },
	{ name: 'x-constant', page: 'x', actor: 'constant', cpu: 4 },
	{ name: 'threads-constant', page: 'threads', actor: 'constant', cpu: 4 },
	{ name: 'feed-constant-1x', page: 'feed', actor: 'constant', cpu: 1 },
	{ name: 'feed-constant-4x', page: 'feed', actor: 'constant', cpu: 4 },
	{ name: 'wiki-text-per-frame', page: 'wiki', actor: 'text-per-frame', folds: 20, cpu: 1 },
	{ name: 'wiki-text-5', page: 'wiki', actor: 'text-5', folds: 20, cpu: 4 },
	{ name: 'feed-html-4x', page: 'feed', actor: 'attribute-on-html', cpu: 4 },
	{ name: 'feed-text-4x', page: 'feed', actor: 'text-per-frame', cpu: 4 },
	{ name: 'feed-key-4x', page: 'feed', actor: 'constant', level: 2, cpu: 4 },
	{ name: 'wiki-text-per-frame-4x', page: 'wiki', actor: 'text-per-frame', folds: 20, cpu: 4 },
	{ name: 'x-text-per-frame', page: 'x', actor: 'text-per-frame', cpu: 4 },
	{ name: 'feed-quiet-4x', page: 'feed', actor: 'none', cpu: 4 },
];
const columns = ['fps', 'over25pct', 'longTasks', 'longMax', 'taskMsPerS', 'scriptMsPerS', 'styleMsPerS', 'layoutsPerS', 'recalcsPerS', 'attrsPerS', 'childsPerS', 'scrolledPerS', 'readsPerS', 'stylesPerS'] as const;
const urls: Record<Scenario['page'], string> = { x: '/x-like/', threads: '/threads-like/', feed: '/feed/', wiki: '/wikipedia-black-hole/' };
const seconds = Number(process.env.TFOLD_SCROLL_SECONDS ?? 10);
const outDir = path.resolve(import.meta.dirname, '..', 'out', 'p5d-scroll');

function feedHtml(count: number): string {
	const words = 'the river road reopened this morning and it runs wider than before with a low curb between riders and cars I rode the whole loop before work and stopped twice at the new crossings small changes like this make the city feel calmer'.split(' ');
	const sentence = (i: number, n: number, seed: number) => `Post ${i} ${Array.from({ length: n }, (_, k) => words[(i * 7 + k * 3 + seed * 11) % words.length]).join(' ')}.`;
	const posts = Array.from({ length: count }, (_, i) => {
		const body = `<p lang="en"><span>${sentence(i, 18, 1)} </span><a href="#m${i}">@friend${i}</a><span> ${sentence(i, 16, 2)} </span><b>${sentence(i, 6, 3)}</b><span> ${sentence(i, 14, 4)}</span></p>`;
		return `<article class="post" data-post="${i}"><div class="head"><a href="#u${i}"><span dir="auto">user${i}</span></a><span class="time"><time datetime="2026-11-04">${i + 1}h</time></span></div><div class="body">${body}</div><div class="actions"><div role="button" aria-label="Like"><span>Like ${i}</span></div><div role="button" aria-label="Reply"><span>Reply</span></div><div role="button" aria-label="Share"><span>Share</span></div></div></article>`;
	}).join('');
	return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>feed</title><style>
body{margin:0;font:15px/21px system-ui,sans-serif;color:#000;background:#fafafa}
.column{max-width:600px;margin:0 auto;padding:16px 0}
.list{background:#fff;border:1px solid #e5e5e5;border-radius:16px}
.post{display:flex;flex-direction:column;gap:4px;padding:12px 24px;border-bottom:1px solid #efefef}
.post p{margin:0}.head{display:flex;gap:8px}.time{color:#666}.actions{display:flex;gap:20px;margin-top:6px;color:#424242;font-size:13px}
</style></head><body><div class="column"><div class="list" id="list">${posts}</div></div></body></html>`;
}

async function mockProvider(): Promise<{ baseUrl: string; close(): Promise<void> }> {
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
			const units = [...prompt.matchAll(/^\[U(\d+)\]/gm)].map(([, n]) => ({ id: `U${n}`, takeaway: `Takeaway ${n} about the river road`, reason: `It runs wider now and has a low curb between riders and cars number ${n}`, evidence: [0, 1] }));
			const content = JSON.stringify({ units });
			response.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(
				JSON.stringify({ id: 'gen-mock', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

const settled = (page: Page) => page.waitForFunction(() => document.querySelector('tfold-ghosts, tfold-gap, [data-tf-pending]') === null, undefined, { timeout: 60_000 });

async function foldShown(h: Harness, level: number, limit: number): Promise<number> {
	const count = await h.inContent<number>(`(() => {
		const tf = globalThis.__tfold;
		let n = 0;
		for (const { id, level } of tf.readBlocks()) {
			if (level !== 0 || n >= ${limit}) continue;
			tf.setLevel(id, ${level});
			n++;
		}
		return n;
	})()`);
	await settled(h.page);
	return count;
}

async function foldPage(h: Harness, { page, folds = 1000, level = 1 }: Scenario): Promise<number> {
	if (page !== 'x') return foldShown(h, level, folds);
	let count = 0;
	for (let y = 0; y <= 16 * 320 && count < folds; y += 640) {
		await h.page.evaluate((y) => scrollTo(0, y), y);
		await h.page.waitForTimeout(40);
		count += await foldShown(h, level, folds - count);
	}
	await h.page.evaluate(() => scrollTo(0, 0));
	await h.page.waitForTimeout(200);
	await settled(h.page);
	return count;
}

function startActors(actor: Actor): void {
	const written: Written = { rows: 0, hover: 0, text: 0, html: 0 };
	Object.assign(globalThis, { written });
	if (actor === 'none') return;
	const articles = () => {
		const found = [...document.querySelectorAll<HTMLElement>('article, .post')];
		return found.length > 0 ? found : [...document.querySelectorAll<HTMLElement>('section')];
	};
	const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="cellInnerDiv"], .post')];
	let n = 0;
	setInterval(() => {
		const list = articles();
		const one = list[n++ % Math.max(list.length, 1)];
		if (!one) return;
		const on = n % 2 === 0;
		one.classList.toggle('hovered', on);
		one.style.outlineColor = on ? 'rgb(1,2,3)' : 'rgb(4,5,6)';
		one.querySelector('button, [role="button"]')?.setAttribute('aria-pressed', String(on));
		written.hover += 3;
	}, 50);
	const bar = document.body.appendChild(document.createElement('div'));
	bar.style.cssText = 'position:fixed;left:0;bottom:0;height:2px;width:0;background:#09f';
	setInterval(() => {
		bar.style.width = `${n % 100}%`;
	}, 100);
	let tick = 0;
	setInterval(() => {
		tick++;
		for (const el of document.querySelectorAll('time, .handle')) {
			el.setAttribute('data-age', String(tick));
			const text = el.firstChild;
			if (text instanceof Text) text.data = `${text.data.replace(/ \d+s$/, '')} ${tick}s`;
		}
	}, 1000);
	const ticker = document.body.appendChild(document.createElement('div'));
	ticker.style.cssText = 'position:fixed;right:0;bottom:0;font-size:10px';
	let frame = 0;
	let flip = 0;
	const raf = () => {
		frame++;
		requestAnimationFrame(raf);
		if (actor === 'text-5') {
			if (frame % 12 === 0) {
				ticker.textContent = String(frame);
				written.text++;
			}
			return;
		}
		if (actor === 'typical' && frame % 12 !== 0) return;
		flip++;
		for (const row of rows()) {
			const base = Math.floor(Number(/translateY\(([\d.]+)/.exec(row.style.transform)?.[1] ?? 0));
			row.style.transform = `translateY(${base + (flip % 2 ? 0.01 : 0)}px)`;
			written.rows++;
		}
		if (actor === 'text-per-frame') {
			ticker.textContent = String(frame);
			written.text++;
		}
		if (actor === 'attribute-on-html') {
			document.documentElement.setAttribute('data-scroll', String(Math.round(scrollY)));
			written.html++;
		}
	};
	requestAnimationFrame(raf);
}

function startMeasure(): void {
	const measure = { frames: [] as number[], long: [] as number[], attrs: 0, childs: 0, chars: 0, scrolled: 0, start: performance.now(), stop: false };
	Object.assign(globalThis, { measure });
	new PerformanceObserver((list) => measure.long.push(...list.getEntries().map((entry) => entry.duration))).observe({ entryTypes: ['longtask'] });
	new MutationObserver((records) => {
		for (const { type } of records) {
			if (type === 'attributes') measure.attrs++;
			else if (type === 'childList') measure.childs++;
			else measure.chars++;
		}
	}).observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
	let last: number | undefined;
	let direction = 1;
	const tick = (now: number) => {
		if (last !== undefined) measure.frames.push(now - last);
		last = now;
		const before = scrollY;
		scrollBy(0, 8 * direction);
		if (scrollY === before || scrollY + innerHeight >= document.documentElement.scrollHeight - 2) direction = -direction;
		measure.scrolled += Math.abs(scrollY - before);
		if (!measure.stop) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

const countReads = `(() => {
	const counts = globalThis.readCounts = { reads: 0, styles: 0 };
	const value = CSSStyleDeclaration.prototype.getPropertyValue;
	CSSStyleDeclaration.prototype.getPropertyValue = function (name) {
		counts.reads++;
		return value.call(this, name);
	};
	const computed = globalThis.getComputedStyle;
	globalThis.getComputedStyle = (...args) => {
		counts.styles++;
		return computed(...args);
	};
})()`;

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
	const { metrics: list } = await cdp.send('Performance.getMetrics');
	return Object.fromEntries(list.map(({ name, value }) => [name, value]));
}

type Profile = { nodes: { id: number; callFrame: { functionName: string; url: string } }[]; samples?: number[]; timeDeltas?: number[] };

function limiter(profile: Profile): [string, number][] {
	const self = new Map<number, number>();
	(profile.samples ?? []).forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0)));
	const totals = new Map<string, number>();
	for (const { id, callFrame } of profile.nodes) {
		const where = callFrame.url.startsWith('chrome-extension://') ? 'tfold' : callFrame.url === '' ? 'native' : 'page';
		const key = `${where}:${callFrame.functionName || '(anonymous)'}`;
		totals.set(key, (totals.get(key) ?? 0) + (self.get(id) ?? 0));
	}
	return [...totals].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, us]) => [key, Math.round(us / 1000)]);
}

async function run(scenario: Scenario, side: string, dist: string, mode: Mode, baseUrl: string): Promise<Row> {
	const h = await launch({ headless: true, allowLiveHosts: ['127.0.0.1'], viewport: { width: 1280, height: 800 } }, dist);
	try {
		await h.worker.evaluate(
			(baseUrl) => chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter: { apiKey: 'mock', baseUrl, model: 'mock/model' } }, hintSeen: true }),
			baseUrl,
		);
		if (scenario.page === 'feed') await h.context.route('**/feed/', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: feedHtml(40) }));
		await h.navigate(urls[scenario.page]);
		await h.page.waitForTimeout(500);
		const folds = await foldPage(h, scenario);
		await settled(h.page);
		const [overlays, local] = await h.page.evaluate(() => [document.querySelectorAll('[data-tfold-overlay]').length, document.querySelectorAll('[data-tf-fold="local"], [data-tf-badge]').length]);
		const cdp = await h.context.newCDPSession(h.page);
		await cdp.send('Performance.enable');
		if (scenario.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: scenario.cpu });
		await h.page.evaluate(startActors, scenario.actor);
		if (mode === 'count') await h.inContent(countReads);
		if (mode === 'profile') {
			await cdp.send('Profiler.enable');
			await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
			await cdp.send('Profiler.start');
		}
		const before = await metrics(cdp);
		const readsBefore = mode === 'count' ? await h.inContent<{ reads: number; styles: number }>('({ ...globalThis.readCounts })') : { reads: 0, styles: 0 };
		await h.page.evaluate(startMeasure);
		await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
		const seen = await h.page.evaluate((): Seen => {
			const { measure, written } = globalThis as unknown as { measure: { frames: number[]; long: number[]; attrs: number; childs: number; chars: number; scrolled: number; start: number; stop: boolean }; written: Written };
			measure.stop = true;
			return { ...measure, elapsed: performance.now() - measure.start, written };
		});
		const after = await metrics(cdp);
		const readsAfter = mode === 'count' ? await h.inContent<{ reads: number; styles: number }>('({ ...globalThis.readCounts })') : { reads: 0, styles: 0 };
		if (mode === 'profile') {
			const { profile } = await cdp.send('Profiler.stop');
			console.log(`limiter ${scenario.name} ${side}: ${JSON.stringify(limiter(profile))}`);
		}
		const perSecond = seen.elapsed / 1000;
		const msPerS = (name: string) => Math.round((((after[name] ?? 0) - (before[name] ?? 0)) * 1000) / perSecond);
		const countPerS = (name: string) => Math.round(((after[name] ?? 0) - (before[name] ?? 0)) / perSecond);
		const row: Row = {
			scenario: scenario.name,
			side,
			mode,
			folds,
			overlays: overlays ?? 0,
			local: local ?? 0,
			fps: Math.round((seen.frames.length / perSecond) * 10) / 10,
			over25pct: Math.round((1000 * seen.frames.filter((ms) => ms > 25).length) / Math.max(seen.frames.length, 1)) / 10,
			longTasks: seen.long.length,
			longMax: Math.round(Math.max(0, ...seen.long)),
			taskMsPerS: msPerS('TaskDuration'),
			scriptMsPerS: msPerS('ScriptDuration'),
			styleMsPerS: msPerS('RecalcStyleDuration'),
			layoutsPerS: countPerS('LayoutCount'),
			recalcsPerS: countPerS('RecalcStyleCount'),
			attrsPerS: Math.round(seen.attrs / perSecond),
			childsPerS: Math.round(seen.childs / perSecond),
			scrolledPerS: Math.round(seen.scrolled / perSecond),
			readsPerS: Math.round((readsAfter.reads - readsBefore.reads) / perSecond),
			stylesPerS: Math.round((readsAfter.styles - readsBefore.styles) / perSecond),
			errors: h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror').map((entry) => entry.text.slice(0, 200)),
		};
		console.log(JSON.stringify({ ...row, written: seen.written }));
		return row;
	} finally {
		await h.close();
	}
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const spread = (values: number[]) => `${median(values)} [${Math.min(...values)}, ${Math.max(...values)}]`;

async function changeCost(h: Harness, cdp: CDPSession, name: string, change: string, count: number, waitMs = 100): Promise<number> {
	const before = await metrics(cdp);
	for (let i = 0; i < count; i++) {
		await h.page.evaluate(change);
		await h.page.waitForTimeout(waitMs);
	}
	const after = await metrics(cdp);
	const ms = (((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000) / count;
	console.log(`${name}: ${ms.toFixed(1)} ms of main thread per change`);
	return ms;
}

test('change probe: the cost of a theme switch and of a change away from every fold, with every block of Wikipedia folded, each side in turn', async () => {
	test.skip(process.env.TFOLD_PROBE !== 'change', 'TFOLD_PROBE=change runs the change probe');
	test.setTimeout(0);
	const sides = (process.env.TFOLD_SCROLL_SIDES ?? `head=${extensionDir}`).split(',').map((pair) => pair.split('=') as [string, string]);
	const runs = Number(process.env.TFOLD_SCROLL_RUNS ?? 5);
	const skins = `(() => {
		const list = document.documentElement.classList;
		const dark = list.contains('skin-theme-clientpref-night');
		list.replace(dark ? 'skin-theme-clientpref-night' : 'skin-theme-clientpref-day', dark ? 'skin-theme-clientpref-day' : 'skin-theme-clientpref-night');
	})()`;
	const away = "document.getElementById('probe-away').textContent = String(performance.now())";
	const attribute = "document.getElementById('probe-away').setAttribute('data-at', String(performance.now()))";
	const seen = new Map<string, number[]>();
	for (let i = 0; i < runs; i++) {
		for (const [side, dist] of sides) {
			for (const level of [1, 2]) {
				const h = await launch({ headless: true, viewport: { width: 1280, height: 800 } }, dist);
				try {
					await h.navigate(urls.wiki);
					await h.page.waitForTimeout(500);
					await h.page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="probe-away"></div>'));
					const folds = await foldShown(h, level, 1000);
					await settled(h.page);
					const cdp = await h.context.newCDPSession(h.page);
					await cdp.send('Performance.enable');
					const note = (what: string, ms: number) => seen.set(`${what} level ${level} ${side}`, [...(seen.get(`${what} level ${level} ${side}`) ?? []), ms]);
					note('theme switch', await changeCost(h, cdp, `${side} ${folds} folds, level ${level}, theme switch`, skins, 6));
					note('text away', await changeCost(h, cdp, `${side} ${folds} folds, level ${level}, text away`, away, 20));
					note('attribute away', await changeCost(h, cdp, `${side} ${folds} folds, level ${level}, attribute away`, attribute, 20));
					await h.page.addStyleTag({ content: 'body { transition: color .3s, background-color .3s; }' });
					await h.page.waitForTimeout(100);
					note('fading theme switch', await changeCost(h, cdp, `${side} ${folds} folds, level ${level}, fading theme switch`, skins, 6, 600));
				} finally {
					await h.close();
				}
			}
		}
	}
	for (const [what, values] of seen) console.log(`${what}: ${spread(values.map((ms) => Math.round(ms * 10) / 10))} ms`);
});

test('scroll probe: a folded page scrolled while its own scripts write to it, each side in turn', async () => {
	test.skip(process.env.TFOLD_PROBE !== 'scroll', 'TFOLD_PROBE=scroll runs the scroll probe');
	test.setTimeout(0);
	const sides = (process.env.TFOLD_SCROLL_SIDES ?? `head=${extensionDir}`).split(',').map((pair) => pair.split('=') as [string, string]);
	const picked = process.env.TFOLD_SCROLL_SCENARIOS?.split(',');
	const runs = Number(process.env.TFOLD_SCROLL_RUNS ?? 5);
	const mode = (process.env.TFOLD_SCROLL_MODE ?? 'timed') as Mode;
	const mock = await mockProvider();
	const rows: Row[] = [];
	await mkdir(outDir, { recursive: true });
	for (const scenario of scenarios.filter(({ name }) => !picked || picked.includes(name))) {
		for (let i = 0; i < runs; i++) {
			for (const [side, dist] of sides) {
				const row = await run(scenario, side, dist, mode, mock.baseUrl);
				rows.push(row);
				await appendFile(path.join(outDir, `${mode}.jsonl`), `${JSON.stringify(row)}\n`);
			}
		}
		for (const [side] of sides) {
			const list = rows.filter((row) => row.scenario === scenario.name && row.side === side);
			const cells = columns.map((column) => `${column} ${spread(list.map((row) => row[column]))}`);
			console.log(`${scenario.name} ${side} n=${list.length} folds=${median(list.map((row) => row.folds))} overlays=${median(list.map((row) => row.overlays))} local=${median(list.map((row) => row.local))} errors=${list.flatMap((row) => row.errors).length}: ${cells.join(', ')}`);
		}
	}
	await mock.close();
});
