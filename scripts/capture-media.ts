import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, expect, type BrowserContext, type CDPSession, type Page, type Route, type Worker } from '@playwright/test';
import { presets } from '../src/fold/providers/presets.ts';

const mediaSrc = path.resolve(import.meta.dirname, '..', 'docs', 'media', 'src');
const demoDir = path.join(mediaSrc, 'demo');
const recordFile = path.join(mediaSrc, 'model-lines.json');
const fontDir = path.join(mediaSrc, 'assets', 'fonts');
const footageDir = path.join(mediaSrc, 'assets', 'footage');
const stillsDir = path.join(mediaSrc, 'assets', 'stills');
const demoHost = 'kitchen-notes.example';
const demoOrigin = `https://${demoHost}`;
const liveHost = new URL(presets.opengateway.baseUrl).hostname;
const listPrice = { input: 0.3e-6, output: 1.2e-6 };
const deviceScale = 2;
// One notch of a mouse wheel, which crosses one step whatever the device scale does to the delta.
const notchDeltaY = 120;
const ctrlModifier = 2;
const frameMs = 1000 / 60;
const transitionSlotMs = 450;
const latchMs = 450;

type Level = 0 | 1 | 2 | 3;
type Lang = 'en' | 'ko';
type Scheme = 'light' | 'dark';
type Viewport = { width: number; height: number };
type Beat = { hold: number } | { to: Level };
type Shot = { name: string; lang: Lang; scheme: Scheme; viewport: Viewport; textPx: number; target: string; beats: Beat[] };
type Frame = { png: Buffer; ms: number };
type Answers = 'none' | 'live' | 'recorded';

const hero: Viewport = { width: 920, height: 464 };
const film: Viewport = { width: 1280, height: 665 };

const shots: Shot[] = [
	{
		name: 'hero-en',
		lang: 'en',
		scheme: 'light',
		viewport: hero,
		textPx: 21,
		target: '#target',
		beats: [{ hold: 1000 }, { to: 1 }, { hold: 1200 }, { to: 2 }, { hold: 1800 }, { to: 3 }, { hold: 2000 }, { to: 2 }, { hold: 250 }, { to: 1 }, { hold: 250 }, { to: 0 }, { hold: 800 }],
	},
	{
		name: 'film-en',
		lang: 'en',
		scheme: 'light',
		viewport: film,
		textPx: 20,
		target: '#target',
		beats: [{ hold: 1100 }, { to: 1 }, { hold: 1050 }, { to: 2 }, { hold: 1300 }, { to: 3 }, { hold: 900 }],
	},
	{
		name: 'film-ko',
		lang: 'ko',
		scheme: 'light',
		viewport: film,
		textPx: 20,
		target: '#target',
		beats: [{ hold: 500 }, { to: 1 }, { hold: 300 }, { to: 2 }, { hold: 500 }, { to: 3 }, { hold: 950 }],
	},
	{
		name: 'film-dark',
		lang: 'en',
		scheme: 'dark',
		viewport: film,
		textPx: 20,
		target: '#target',
		beats: [{ hold: 450 }, { to: 1 }, { hold: 150 }, { to: 2 }, { hold: 700 }],
	},
];

type Line = { page: Lang; paragraph: string; level: Level; from: string | null; text: string };
type Usage = { provider: string; promptTokens: number; completionTokens: number; reasoningTokens: number; cost?: number; upstream?: string; blocks: number; ms: number };

const usages: Usage[] = [];
const lines = new Map<string, Line>();

const noteLine = (line: Line) => lines.set(`${line.page} ${line.paragraph} ${line.level}`, line);

function serveDemo(route: Route, url: URL): Promise<void> {
	if (url.pathname.startsWith('/fonts/')) return route.fulfill({ path: path.join(fontDir, path.basename(url.pathname)), contentType: 'font/woff2' });
	if (url.pathname === '/demo.css') return route.fulfill({ path: path.join(demoDir, 'demo.css'), contentType: 'text/css; charset=utf-8' });
	if (url.pathname === '/en/' || url.pathname === '/ko/') return route.fulfill({ path: path.join(demoDir, `${url.pathname.slice(1, 3)}.html`), contentType: 'text/html; charset=utf-8' });
	return route.fulfill({ status: 404 });
}

const lineOf = (recorded: Line[], page: Lang, level: Level) => recorded.find((line) => line.page === page && line.level === level)?.text ?? '';

// Answers a fold request with the recorded lines, so a rebuild shows the same text as the stills and needs no key. A unit
// with no recorded line gets the empty answer that keeps its quick summary.
function recordedAnswer(prompt: string, recorded: Line[]): string {
	const units = [...prompt.matchAll(/^\[U(\d+)\] .*\n((?: {2}\d+: .*\n?)+)/gm)].map(([, n, body]) => {
		const sentences = (body ?? '').trim().split('\n').map((line) => line.replace(/^\s*\d+: /, ''));
		const brief = recorded.find((line) => line.level === 1 && sentences.some((sentence) => line.text.includes(sentence)));
		if (!brief) return { id: `U${n}`, takeaway: '', reason: '', evidence: [0] };
		const takeaway = lineOf(recorded, brief.page, 3);
		return {
			id: `U${n}`,
			takeaway,
			reason: lineOf(recorded, brief.page, 2).slice(takeaway.length).trim(),
			evidence: sentences.flatMap((sentence, i) => (brief.text.includes(sentence) ? [i] : [])),
		};
	});
	return JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ units }) } }], usage: { prompt_tokens: 0, completion_tokens: 0 } });
}

async function serveRecorded(route: Route, recorded: Line[]): Promise<void> {
	const { messages } = route.request().postDataJSON() as { messages: { content: string }[] };
	await route.fulfill({ status: 200, contentType: 'application/json', body: recordedAnswer(messages.at(-1)?.content ?? '', recorded) });
}

async function open(extension: string, answers: Answers, recorded: Line[] = []): Promise<{ context: BrowserContext; worker: Worker; page: Page; cdp: CDPSession; extensionId: string; userDataDir: string }> {
	const userDataDir = await mkdtemp(path.join(tmpdir(), 'tfold-media-'));
	const context = await chromium.launchPersistentContext(userDataDir, {
		channel: 'chromium',
		headless: true,
		viewport: film,
		deviceScaleFactor: deviceScale,
		env: { ...process.env, FONTCONFIG_FILE: path.join(mediaSrc, 'fonts.conf') },
		args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-quic', '--enable-unsafe-extension-debugging', '--font-render-hinting=none', ...(answers === 'none' ? [`--force-device-scale-factor=${deviceScale}`] : [])],
	});
	await context.route('**/*', (route) => {
		const url = new URL(route.request().url());
		if (url.hostname === demoHost) return serveDemo(route, url);
		if (url.hostname === liveHost && answers === 'live') return route.fallback();
		if (url.hostname === liveHost && answers === 'recorded') return serveRecorded(route, recorded);
		if (url.protocol === 'https:' || url.protocol === 'http:') return route.abort('blockedbyclient');
		return route.fallback();
	});
	context.on('console', (message) => {
		const [, usage] = /^fold usage (\{.*\})$/.exec(message.text()) ?? [];
		if (usage) usages.push(JSON.parse(usage) as Usage);
	});
	const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
	const page = context.pages()[0] ?? (await context.newPage());
	return { context, worker, page, cdp: await context.newCDPSession(page), extensionId: new URL(worker.url()).host, userDataDir };
}

async function load(page: Page, { lang, scheme, viewport, textPx }: Pick<Shot, 'lang' | 'scheme' | 'viewport' | 'textPx'>): Promise<void> {
	await page.setViewportSize(viewport);
	await page.emulateMedia({ colorScheme: scheme });
	await page.goto(`${demoOrigin}/${lang}/`, { waitUntil: 'load' });
	await page.evaluate((px) => document.documentElement.style.setProperty('--size', `${px}px`), textPx);
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
	await page.waitForFunction(() => document.fonts.check('20px Pretendard'));
}

const overlaySelector = (target: string) => `${target} + [data-tfold-overlay]`;

async function pointer(page: Page, cdp: CDPSession, target: string): Promise<{ x: number; y: number }> {
	const point = await page.locator(target).evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const first = range.getClientRects()[0];
		if (!first) throw new Error('the paragraph has no text to point at');
		return { x: first.left + first.width * 0.72, y: first.top + first.height / 2 };
	});
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
	return point;
}

// The key goes down first, because a wheel with Control set and no key down stays with the browser.
async function wheel(page: Page, cdp: CDPSession, { x, y }: { x: number; y: number }, direction: 1 | -1): Promise<void> {
	await page.keyboard.down('Control');
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: ctrlModifier });
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: direction * notchDeltaY, modifiers: ctrlModifier });
	await page.keyboard.up('Control');
}

const shoot = (page: Page) => page.screenshot({ type: 'png' });

const twoFrames = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const seekAll = (page: Page, ms: number) =>
	page.evaluate((ms) => {
		for (const animation of document.getAnimations()) {
			animation.pause();
			animation.currentTime = ms;
		}
	}, ms);

const finishAll = (page: Page) =>
	page.evaluate(() => {
		for (const animation of document.getAnimations()) animation.finish();
	});

async function waitForModel(page: Page, target: string): Promise<void> {
	await page.locator(overlaySelector(target)).waitFor({ state: 'attached' });
	await page.waitForFunction(
		(selector) => {
			const overlay = document.querySelector(selector);
			return overlay?.getAttribute('data-tf-fold') === 'model' && !overlay.hasAttribute('data-tf-pending');
		},
		overlaySelector(target),
		{ timeout: 30_000 },
	);
}

async function settle(page: Page): Promise<void> {
	await page.waitForTimeout(100);
	await finishAll(page);
	await twoFrames(page);
	await page.waitForFunction(() => {
		const bar = document.querySelector('tf-bar')?.shadowRoot?.querySelector('.bar');
		return (!bar || getComputedStyle(bar).opacity === '0') && document.getAnimations().length === 0;
	});
}

async function prefetch(page: Page, cdp: CDPSession, target: string): Promise<{ x: number; y: number }> {
	const at = await pointer(page, cdp, target);
	const overlay = page.locator(overlaySelector(target));
	// The content script starts listening once the worker answers its first message, some time after the load event.
	await expect
		.poll(
			async () => {
				if ((await overlay.count()) === 0) await wheel(page, cdp, at, 1);
				return overlay.count();
			},
			{ timeout: 10_000 },
		)
		.toBe(1);
	await waitForModel(page, target);
	await settle(page);
	await foldTo(page, cdp, at, (await levelNow(page, target)) as Level, 0);
	return at;
}

const levelNow = (page: Page, target: string) => page.locator(overlaySelector(target)).evaluate((overlay) => Number(overlay.getAttribute('data-tf-level')));

async function readLine(page: Page, target: string): Promise<{ from: string | null; text: string }> {
	return page.locator(overlaySelector(target)).evaluate((overlay) => ({ from: overlay.getAttribute('data-tf-fold'), text: overlay.textContent ?? '' }));
}

async function transition(page: Page, cdp: CDPSession, at: { x: number; y: number }, direction: 1 | -1, frames: Frame[]): Promise<void> {
	await page.waitForTimeout(latchMs);
	await page.keyboard.down('Control');
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...at, deltaX: 0, deltaY: direction * notchDeltaY, modifiers: ctrlModifier });
	await page.waitForFunction(() => document.querySelector('tfold-ghosts') !== null && document.getAnimations().length > 0, undefined, { timeout: 3000 });
	await seekAll(page, 0);
	const slotFrames = Math.round(transitionSlotMs / frameMs);
	for (let i = 0; i < slotFrames - 1; i++) {
		await seekAll(page, i * frameMs);
		await twoFrames(page);
		frames.push({ png: await shoot(page), ms: frameMs });
	}
	await page.keyboard.up('Control');
	await settle(page);
	frames.push({ png: await shoot(page), ms: frameMs });
}

function joined(frames: Frame[]): Frame[] {
	const out: (Frame & { hash: string })[] = [];
	for (const { png, ms } of frames) {
		const hash = createHash('sha256').update(png).digest('hex');
		const last = out.at(-1);
		if (last?.hash === hash) last.ms += ms;
		else out.push({ png, ms, hash });
	}
	return out;
}

async function encode(name: string, frames: Frame[]): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), `tfold-${name}-`));
	const parts = joined(frames);
	const totalMs = frames.reduce((sum, frame) => sum + frame.ms, 0);
	const list: string[] = [];
	for (const [i, { png, ms }] of parts.entries()) {
		const file = path.join(dir, `${String(i).padStart(5, '0')}.png`);
		await writeFile(file, png);
		list.push(`file '${file}'`, `duration ${(ms / 1000).toFixed(6)}`);
	}
	list.push(`file '${path.join(dir, `${String(parts.length - 1).padStart(5, '0')}.png`)}'`);
	const listFile = path.join(dir, 'list.txt');
	await writeFile(listFile, `${list.join('\n')}\n`);
	await mkdir(footageDir, { recursive: true });
	const output = path.join(footageDir, `${name}.mp4`);
	const run = spawnSync(
		'ffmpeg',
		['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'fps=60,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-t', (totalMs / 1000).toFixed(3), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-g', '30', '-movflags', '+faststart', output],
		{ stdio: 'inherit' },
	);
	if (run.status !== 0) throw new Error(`ffmpeg failed for ${name}`);
	await rm(dir, { recursive: true, force: true });
	console.log(`${name}: ${parts.length} distinct frames, ${(totalMs / 1000).toFixed(2)} s`);
}

async function shootShot(page: Page, cdp: CDPSession, shot: Shot): Promise<{ x: number; y: number }> {
	await load(page, shot);
	const at = await prefetch(page, cdp, shot.target);
	const frames: Frame[] = [];
	let level: Level = 0;
	for (const beat of shot.beats) {
		if ('hold' in beat) {
			const png = frames.at(-1)?.png ?? (await shoot(page));
			frames.push({ png, ms: beat.hold });
			continue;
		}
		const direction = beat.to > level ? 1 : -1;
		await transition(page, cdp, at, direction, frames);
		level = beat.to;
		if (level !== 0) {
			const { from, text } = await readLine(page, shot.target);
			noteLine({ page: shot.lang, paragraph: shot.target, level, from, text });
			if (from !== 'model') throw new Error(`${shot.name} level ${level} shows a ${from} fold`);
		}
	}
	await encode(shot.name, frames);
	console.log(`${shot.name}: pointer at ${Math.round(at.x)},${Math.round(at.y)} of ${shot.viewport.width}x${shot.viewport.height}`);
	return at;
}

async function clipOf(page: Page, target: string, level: Level, pad: number): Promise<{ x: number; y: number; width: number; height: number }> {
	const selector = level === 0 ? target : overlaySelector(target);
	const box = await page.locator(selector).evaluate((el) => {
		const { x, y, width, height } = el.getBoundingClientRect();
		return { x, y, width, height };
	});
	return { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
}

async function foldTo(page: Page, cdp: CDPSession, at: { x: number; y: number }, from: Level, to: Level): Promise<void> {
	for (let level = from; level !== to; level = (level + Math.sign(to - level)) as Level) {
		await page.waitForTimeout(latchMs);
		await wheel(page, cdp, at, to > level ? 1 : -1);
		await settle(page);
	}
}

async function levelStills(page: Page, cdp: CDPSession): Promise<void> {
	const target = '#target';
	for (const lang of ['ko', 'en'] as const) {
		await load(page, { lang, scheme: 'light', viewport: { width: 780, height: 900 }, textPx: 21 });
		const at = await prefetch(page, cdp, target);
		let level: Level = 0;
		for (const next of [0, 1, 2, 3] as const) {
			await foldTo(page, cdp, at, level, next);
			level = next;
			await page.screenshot({ path: path.join(stillsDir, `levels-${lang}-${next}.png`), clip: await clipOf(page, target, next, 14) });
			if (next !== 0) noteLine({ page: lang, paragraph: target, level: next, ...(await readLine(page, target)) });
		}
	}
}

async function themeStills(page: Page, cdp: CDPSession): Promise<void> {
	for (const scheme of ['light', 'dark'] as const) {
		await load(page, { lang: 'en', scheme, viewport: { width: 600, height: 640 }, textPx: 19 });
		const at = await prefetch(page, cdp, '#target');
		await foldTo(page, cdp, at, 0, 3);
		await page.screenshot({ path: path.join(stillsDir, `theme-${scheme}.png`) });
	}
}

async function socialStills(page: Page, cdp: CDPSession): Promise<void> {
	await load(page, { lang: 'en', scheme: 'light', viewport: { width: 640, height: 900 }, textPx: 22 });
	const at = await prefetch(page, cdp, '#target');
	await page.screenshot({ path: path.join(stillsDir, 'social-full.png'), clip: await clipOf(page, '#target', 0, 18) });
	await foldTo(page, cdp, at, 0, 3);
	await page.screenshot({ path: path.join(stillsDir, 'social-takeaway.png'), clip: await clipOf(page, '#target', 3, 18) });
	noteLine({ page: 'en', paragraph: '#target', level: 3, ...(await readLine(page, '#target')) });
}

type RawSession = {
	send(method: string, params?: object): Promise<unknown>;
	on(event: 'Target.receivedMessageFromTarget', listener: (event: { sessionId: string; message: string }) => void): void;
	detach(): Promise<void>;
};
type TargetInfo = { targetId: string; url: string };

async function shootPopup(context: BrowserContext, page: Page, extensionId: string, scheme: Scheme, file: string): Promise<void> {
	const browser = context.browser();
	if (!browser) throw new Error('the context has no browser');
	const session = (await browser.newBrowserCDPSession()) as unknown as RawSession;
	const targets = async (filter?: object[]) => ((await session.send('Target.getTargets', filter && { filter })) as { targetInfos: TargetInfo[] }).targetInfos;
	const tab = (await targets([{ type: 'tab' }])).find((info) => info.url === page.url());
	if (!tab) throw new Error(`no tab shows ${page.url()}`);
	await session.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
	const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
	let popup: TargetInfo | undefined;
	for (const started = Date.now(); !popup && Date.now() - started < 5000; await new Promise((resolve) => setTimeout(resolve, 50))) {
		popup = (await targets()).find((info) => info.url === popupUrl);
	}
	if (!popup) throw new Error('the toolbar action opened no popup');
	const { sessionId } = (await session.send('Target.attachToTarget', { targetId: popup.targetId, flatten: false })) as { sessionId: string };
	const pending = new Map<number, (result: unknown) => void>();
	let lastId = 0;
	session.on('Target.receivedMessageFromTarget', (event) => {
		if (event.sessionId !== sessionId) return;
		const reply = JSON.parse(event.message) as { id?: number; result?: unknown };
		if (reply.id !== undefined) pending.get(reply.id)?.(reply.result);
	});
	const send = <T>(method: string, params: object = {}) =>
		new Promise<T>((resolve, reject) => {
			const id = ++lastId;
			pending.set(id, (result) => resolve(result as T));
			session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
		});
	const evaluate = async <T>(expression: string) => (await send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
	await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
	await evaluate(`new Promise((resolve) => { const poll = () => (performance.getEntriesByName('tfold-ready').length > 0 ? resolve(true) : setTimeout(poll, 20)); poll(); })`);
	await evaluate('document.fonts.ready.then(() => Promise.all(document.getAnimations().map((animation) => animation.finished))).then(() => true)');
	await new Promise((resolve) => setTimeout(resolve, 300));
	const box = await evaluate<{ width: number; height: number }>(`({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })`);
	const { data } = await send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: box.width, height: box.height, scale: 1 } });
	await writeFile(file, Buffer.from(data, 'base64'));
	await send('Runtime.evaluate', { expression: 'close()' }).catch(() => undefined);
	await session.detach().catch(() => undefined);
}

async function popups(extension: string): Promise<void> {
	const { context, worker, page, extensionId, userDataDir } = await open(extension, 'none');
	try {
		// hintSeen stays unset, so the popup shows every way to fold, as it does before a reader's first fold.
		await worker.evaluate(() => chrome.storage.local.set({ account: { kind: 'free' }, providers: { chosen: 'opengateway', opengateway: { apiKey: 'unused' } } }));
		await page.goto(`${demoOrigin}/en/`, { waitUntil: 'load' });
		for (const readerLanguage of ['en', 'ko'] as const) {
			await worker.evaluate((readerLanguage) => chrome.storage.sync.set({ readerLanguage }), readerLanguage);
			for (const scheme of ['light', 'dark'] as const) await shootPopup(context, page, extensionId, scheme, path.join(stillsDir, `popup-${readerLanguage}-${scheme}.png`));
		}
	} finally {
		await context.close();
		await rm(userDataDir, { recursive: true, force: true });
	}
}

async function folds(extension: string, live: boolean): Promise<void> {
	const key = live ? (process.env.OPENGATEWAY_API_KEY ?? '') : 'unused';
	if (key === '') throw new Error('OPENGATEWAY_API_KEY is not set');
	const recorded = (JSON.parse(await readFile(recordFile, 'utf8')) as { lines: Line[] }).lines;
	const { context, worker, page, cdp, userDataDir } = await open(extension, live ? 'live' : 'recorded', recorded);
	try {
		await worker.evaluate((apiKey) => chrome.storage.local.set({ account: { kind: 'free' }, hintSeen: true, providers: { chosen: 'opengateway', opengateway: { apiKey } } }), key);
		for (const shot of shots) await shootShot(page, cdp, shot);
		await levelStills(page, cdp);
		await themeStills(page, cdp);
		await socialStills(page, cdp);
	} finally {
		await context.close();
		await rm(userDataDir, { recursive: true, force: true });
	}
	if (!live) {
		for (const { page: lang, level, text } of lines.values()) {
			if (text !== lineOf(recorded, lang, level)) throw new Error(`the ${lang} page at level ${level} showed text that is not in the record: ${text}`);
		}
		console.log(`${lines.size} lines match the record`);
		return;
	}
	const cost = usages.reduce((sum, usage) => sum + usage.promptTokens * listPrice.input + usage.completionTokens * listPrice.output, 0);
	const record = {
		capturedFrom: { provider: 'opengateway', model: presets.opengateway.model, page: demoOrigin },
		edited: false,
		lines: [...lines.values()],
		calls: usages,
		listPriceUsd: Number(cost.toFixed(6)),
	};
	await writeFile(recordFile, `${JSON.stringify(record, null, '\t')}\n`);
	console.log(`calls: ${usages.length}; about $${cost.toFixed(6)} at the list price`);
}

const stills: { file: string; page: string; viewport: Viewport; scale: number; fullPage: boolean }[] = [
	{ file: 'tfold-social.png', page: 'social.html', viewport: { width: 1280, height: 640 }, scale: 1, fullPage: false },
	{ file: 'tfold-levels.png', page: 'levels.html', viewport: { width: 900, height: 400 }, scale: 2, fullPage: true },
	{ file: 'tfold-levels-ko.png', page: 'levels.html?lang=ko', viewport: { width: 900, height: 400 }, scale: 2, fullPage: true },
	{ file: 'tfold-themes.png', page: 'themes.html', viewport: { width: 860, height: 400 }, scale: 2, fullPage: true },
	{ file: 'tfold-popup.png', page: 'popup.html', viewport: { width: 760, height: 400 }, scale: 2, fullPage: true },
	{ file: 'tfold-popup-ko.png', page: 'popup.html?lang=ko', viewport: { width: 760, height: 400 }, scale: 2, fullPage: true },
];

async function composeStills(outDir: string): Promise<void> {
	const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--allow-file-access-from-files'] });
	try {
		for (const { file, page: html, viewport, scale, fullPage } of stills) {
			const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
			await page.goto(`file://${path.join(mediaSrc, 'stills', html)}`, { waitUntil: 'load' });
			await page.evaluate(() => document.fonts.ready.then(() => undefined));
			await page.screenshot({ path: path.join(outDir, file), fullPage });
			await page.close();
		}
	} finally {
		await browser.close();
	}
}

const { values } = parseArgs({ options: { folds: { type: 'string' }, live: { type: 'boolean', default: false }, popups: { type: 'string' }, stills: { type: 'string' } } });
await mkdir(stillsDir, { recursive: true });
await readFile(path.join(fontDir, 'Pretendard-Regular.woff2'));
if (values.folds) await folds(path.resolve(values.folds), values.live);
if (values.popups) await popups(path.resolve(values.popups));
if (values.stills) await composeStills(path.resolve(values.stills));
