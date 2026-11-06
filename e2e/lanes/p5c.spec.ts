import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { presets } from '../../src/fold/providers/presets.ts';
import { fixtures, launch, type Harness, type Point } from '../harness.ts';
import { expect, test } from '../lane.ts';
import { openGatewayKeyReply } from '../provider-replies.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p5c');
const latchMs = 400;
const koWiki = '/wikipedia-ko-black-hole/';
const wikiParagraphs = '#mw-content-text section > p:not(.mw-empty-elt):not([data-tfold-overlay])';
const ogKey = process.env.OPENGATEWAY_API_KEY ?? '';
const ogHost = new URL(presets.opengateway.baseUrl).hostname;
const ogPrice = { input: 0.3e-6, output: 1.2e-6 };

const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const workerLines = (h: Harness, prefix: string) =>
	h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith(prefix)).map((entry) => entry.text);
const optionsUrl = (h: Harness) => `chrome-extension://${h.extensionId}/options/options.html`;

type Usage = { provider: string; promptTokens: number; completionTokens: number; reasoningTokens: number; cost?: number; blocks: number; ms: number };
const usages = (h: Harness): Usage[] => workerLines(h, 'fold usage ').map((line) => JSON.parse(line.slice('fold usage '.length)) as Usage);

async function fresh(slug: string): Promise<string> {
	const file = path.join(outDir, `${slug}.png`);
	await mkdir(outDir, { recursive: true });
	await rm(file, { force: true });
	return file;
}

type Dialect = 'opengateway' | 'openrouter' | 'neither';
type Mock = { baseUrl: string; dialects: Dialect[]; status: number | 'reset'; close(): Promise<void> };

const same = (value: unknown, expected: unknown) => JSON.stringify(value) === JSON.stringify(expected);

function dialectOf(body: Record<string, unknown>): Dialect {
	if (body.reasoning_effort === 'none' && !('provider' in body) && !('reasoning' in body)) return 'opengateway';
	if (same(body.reasoning, { enabled: false }) && same(body.provider, { require_parameters: true }) && !('reasoning_effort' in body)) return 'openrouter';
	return 'neither';
}

async function mockProvider(status: Mock['status'] = 200): Promise<Mock> {
	const dialects: Dialect[] = [];
	const mock: Mock = { baseUrl: '', dialects, status, close: () => Promise.resolve() };
	const server = http.createServer((request, response) => {
		const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
		if (request.method === 'OPTIONS') {
			response.writeHead(204, cors).end();
			return;
		}
		let raw = '';
		request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		request.on('end', () => {
			if (request.method === 'GET') {
				response.writeHead(200, cors).end('{"data":{"label":"mock"}}');
				return;
			}
			const body = JSON.parse(raw) as Record<string, unknown> & { messages: { content: string }[] };
			if (!('messages' in body)) {
				response.writeHead(400, cors).end(openGatewayKeyReply(raw));
				return;
			}
			const dialect = dialectOf(body);
			dialects.push(dialect);
			if (mock.status === 'reset') {
				request.socket.destroy();
				return;
			}
			if (mock.status !== 200) {
				response.writeHead(mock.status, { ...cors, 'content-type': 'application/json' }).end('{"error":{"message":"busy"}}');
				return;
			}
			const prompt = body.messages.at(-1)?.content ?? '';
			const units = [...prompt.matchAll(/^\[U(\d+)\]/gm)].map(([, n]) => ({ id: `U${n}`, takeaway: `Mock ${dialect} ${dialects.length}`, reason: '', evidence: [0] }));
			response.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(
				JSON.stringify({
					id: 'gen-mock',
					choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ units }) } }],
					usage: { prompt_tokens: 0, completion_tokens: 0 },
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	mock.baseUrl = `http://127.0.0.1:${port}/v1`;
	mock.close = async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	};
	return mock;
}

const seed = (h: Harness, providers: object) => h.worker.evaluate((value) => chrome.storage.local.set({ providers: value, hintSeen: true }), providers);

type Overlay = { level: string | null; fold: string | null; badge: string | null; text: string | null };

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
				text: shown ? (shown.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
			};
		},
		{ selector: wikiParagraphs, index },
	);
}

async function settled(h: Harness, index: number, want: (shown: Overlay) => boolean, timeout = 20_000): Promise<Overlay> {
	await expect.poll(async () => want(await overlay(h.page, index)), { timeout, intervals: [50] }).toBe(true);
	return overlay(h.page, index);
}

async function aim(h: Harness, index: number): Promise<Point> {
	await h.page.evaluate(
		({ selector, index }) => {
			for (const marked of document.querySelectorAll('[data-p5c-target]')) marked.removeAttribute('data-p5c-target');
			const el = document.querySelectorAll(selector)[index];
			(el?.checkVisibility() ? el : el?.nextElementSibling)?.setAttribute('data-p5c-target', '');
		},
		{ selector: wikiParagraphs, index },
	);
	return h.pointAt('[data-p5c-target]');
}

async function foldBy(h: Harness, index: number, steps: number): Promise<void> {
	const point = await aim(h, index);
	await h.foldAt(point.x, point.y, steps);
}

const modelFold = (shown: Overlay) => shown.fold === 'model';
const badged = (shown: Overlay) => shown.badge !== null;

async function openOptions(h: Harness): Promise<Page> {
	const options = await h.context.newPage();
	await options.goto(optionsUrl(h));
	await expect(options.locator('#route')).not.toBeEmpty();
	return options;
}

const optionsState = (options: Page) =>
	options.evaluate(() => ({
		checked: document.getElementById('key-label')?.textContent?.split(' ')[0]?.toLowerCase() ?? null,
		route: document.getElementById('route')?.textContent ?? '',
		status: document.getElementById('status')?.textContent ?? '',
		model: (document.getElementById('model') as HTMLInputElement).value,
	}));

async function saveKeys(options: Page, keys: { opengateway?: string; openrouter?: string }): Promise<void> {
	for (const [id, key] of Object.entries(keys)) {
		const { checked } = await optionsState(options);
		const field = options.locator(checked === id ? '#key' : '#backup-key');
		if (!(await field.isVisible())) await options.locator('#advanced > summary').click();
		await field.fill(key);
	}
	await options.locator('button[type="submit"]').click();
	await expect(options.locator('#status')).toHaveText(/key works and is saved/);
}

async function choose(options: Page, id: 'opengateway' | 'openrouter'): Promise<void> {
	if (!(await options.locator('#use-other').isVisible())) await options.locator('#advanced > summary').click();
	await options.locator('#use-other').click();
	await expect(options.locator('#route')).toHaveText(new RegExp(`^AI summaries come from ${presets[id].name}`));
}

test.describe('live OpenGateway', () => {
	test.use({ allowLiveHosts: [ogHost] });
	test.skip(ogKey === '', 'OPENGATEWAY_API_KEY is not set');

	test('lane 1: a new install starts on OpenGateway, its key saves there, and a Korean paragraph folds live with reasoning off', async ({ h }) => {
		const png = await fresh('p5c-options-opengateway');
		const options = await openOptions(h);
		const before = await optionsState(options);
		await saveKeys(options, { opengateway: ogKey });
		const after = await optionsState(options);
		await options.locator('#provider').screenshot({ path: png });
		const typed = await options.evaluate((key) => document.documentElement.outerHTML.includes(key) || [...document.querySelectorAll('input')].some((input) => input.value.includes(key)), ogKey);
		await options.close();

		await h.navigate(koWiki);
		await h.page.waitForTimeout(500);
		const point = await aim(h, 1);
		const tried = Date.now();
		await h.foldAt(point.x, point.y, 2);
		const shown = await settled(h, 1, modelFold);
		const waitedMs = Date.now() - tried;
		const [usage] = usages(h);
		const letters = [...(shown.text ?? '')].filter((c) => /\p{L}/u.test(c));
		const hangul = letters.filter((c) => /\p{Script=Hangul}/u.test(c)).length / Math.max(1, letters.length);
		const cost = usage ? usage.promptTokens * ogPrice.input + usage.completionTokens * ogPrice.output : 0;

		console.log(`options before the key: ${JSON.stringify(before)}`);
		console.log(`options after the key: ${JSON.stringify(after)}`);
		console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
		console.log(`first how: the model fold showed ${waitedMs} ms after the first wheel event, the OpenGateway call took ${usage?.ms} ms`);
		console.log(`Key: ${shown.text}; Hangul share ${hangul.toFixed(2)}; about $${cost.toFixed(6)} at the list price`);
		expect(before).toMatchObject({ checked: 'opengateway', route: 'tfold folds with quick summaries now.' });
		expect(after).toEqual({
			checked: 'opengateway',
			route: 'AI summaries come from OpenGateway.',
			status: 'The OpenGateway key works and is saved.',
			model: presets.opengateway.model,
		});
		expect(typed).toBe(false);
		expect(workerLines(h, 'fold request to ')).toEqual([expect.stringMatching(new RegExp(`^fold request to ${ogHost}, ${presets.opengateway.model}, `))]);
		expect(usage?.provider).toBe('opengateway');
		expect(usage?.reasoningTokens).toBeLessThanOrEqual(10);
		expect((usage?.completionTokens ?? Infinity) / (usage?.blocks ?? 1)).toBeLessThan(150);
		expect(shown).toMatchObject({ level: '2', fold: 'model', badge: null });
		expect(hangul).toBeGreaterThan(0.6);
		expect(workerLines(h, 'fold fallback')).toEqual([]);
		expect(errors(h)).toEqual([]);
	});
});

test.describe('mock providers', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	test('lane 2: a 429 from the chosen provider goes once to the other provider, which answers in its own request body, the worker names it, and the answer is cached for that provider only', async ({
		h,
	}) => {
		const busy = await mockProvider(429);
		const other = await mockProvider();
		const providers = {
			opengateway: { apiKey: 'mock-og', baseUrl: busy.baseUrl, model: 'mock/model' },
			openrouter: { apiKey: 'mock-or', baseUrl: other.baseUrl, model: 'mock/model' },
		};
		const foldOnce = async () => {
			await h.navigate(fixtures.wiki);
			await foldBy(h, 1, 3);
			return settled(h, 1, modelFold);
		};
		try {
			await seed(h, { chosen: 'opengateway', ...providers });
			const fellBack = await foldOnce();
			const fallbackLines = workerLines(h, 'fold ');
			busy.status = 200;
			const recovered = await foldOnce();
			await seed(h, { chosen: 'openrouter', ...providers });
			const cached = await foldOnce();
			console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
			console.log(`Takeaways: after the 429 ${fellBack.text}; OpenGateway back ${recovered.text}; OpenRouter chosen ${cached.text}`);
			console.log(`the busy provider saw ${JSON.stringify(busy.dialects)}, the other saw ${JSON.stringify(other.dialects)}`);
			expect(fellBack).toMatchObject({ level: '3', fold: 'model', badge: null });
			expect(fellBack.text).toContain('Mock openrouter 1');
			expect(fallbackLines).toEqual([
				'fold received, 5 blocks',
				expect.stringMatching(/^fold request to 127\.0\.0\.1:\d+, mock\/model, 5 blocks, 0 cached$/),
				expect.stringMatching(/^fold fallback to openrouter after opengateway rate-limit, HTTP 429, \d+ ms$/),
				expect.stringMatching(/^fold usage \{"provider":"openrouter",/),
			]);
			expect(recovered.text).toContain('Mock opengateway 2');
			expect(cached.text).toContain('Mock openrouter 1');
			expect(busy.dialects).toEqual(['opengateway', 'opengateway']);
			expect(other.dialects).toEqual(['openrouter']);
			expect(usages(h).map((usage) => usage.provider)).toEqual(['openrouter', 'opengateway']);
			expect(workerLines(h, 'fold cache hit')).toHaveLength(1);
			expect(workerLines(h, 'fold failed')).toEqual([]);
			expect(errors(h)).toEqual([]);
		} finally {
			await busy.close();
			await other.close();
		}
	});

	test('lane 3: with a key for the chosen provider only, a 429 shows the rate limit badge and nothing goes to the other provider', async ({ h }) => {
		const png = await fresh('p5c-one-key');
		const busy = await mockProvider(429);
		const other = await mockProvider();
		try {
			await seed(h, {
				opengateway: { apiKey: 'mock-og', baseUrl: busy.baseUrl, model: 'mock/model' },
				openrouter: { baseUrl: other.baseUrl, model: 'mock/model' },
			});
			await h.navigate(fixtures.wiki);
			await foldBy(h, 1, 1);
			const shown = await settled(h, 1, badged);
			await h.page.locator(`${wikiParagraphs} >> nth=1`).evaluate((el) => el.nextElementSibling?.scrollIntoView({ block: 'center' }));
			await h.page.screenshot({ path: png });
			console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
			expect(shown).toMatchObject({ level: '1', fold: 'local', badge: 'Too many requests · try again' });
			expect(busy.dialects).toEqual(['opengateway']);
			expect(other.dialects).toEqual([]);
			expect(workerLines(h, 'fold failed')).toEqual([expect.stringMatching(/^fold failed, rate-limit, HTTP 429, \d+ ms$/)]);
			expect(workerLines(h, 'fold fallback')).toEqual([]);
		} finally {
			await busy.close();
			await other.close();
		}
	});

	test('lane 4: when the other provider fails too, the badge reports the chosen provider and the worker logs both', async ({ h }) => {
		const busy = await mockProvider(429);
		const refused = await mockProvider(401);
		try {
			await seed(h, {
				opengateway: { apiKey: 'mock-og', baseUrl: busy.baseUrl, model: 'mock/model' },
				openrouter: { apiKey: 'mock-or-stale', baseUrl: refused.baseUrl, model: 'mock/model' },
			});
			await h.navigate(fixtures.wiki);
			await foldBy(h, 1, 1);
			const shown = await settled(h, 1, badged);
			console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
			expect(shown).toMatchObject({ level: '1', fold: 'local', badge: 'Too many requests · try again' });
			expect(busy.dialects).toEqual(['opengateway']);
			expect(refused.dialects).toEqual(['openrouter']);
			expect(workerLines(h, 'fold fallback')).toEqual([
				expect.stringMatching(/^fold fallback to openrouter after opengateway rate-limit, HTTP 429, \d+ ms$/),
				expect.stringMatching(/^fold fallback failed, openrouter refused, HTTP 401, \d+ ms$/),
			]);
			expect(workerLines(h, 'fold failed')).toEqual([expect.stringMatching(/^fold failed, rate-limit, HTTP 429, \d+ ms$/)]);
		} finally {
			await busy.close();
			await refused.close();
		}
	});

	test('lane 5: the options page starts on OpenGateway and keeps it when a second key is saved, the reader switches provider there, and a cached fold from one provider never answers for the other', async ({ h }) => {
		const png = await fresh('p5c-options-both');
		const mock = await mockProvider();
		try {
			await seed(h, { opengateway: { baseUrl: mock.baseUrl, model: 'mock/model' }, openrouter: { baseUrl: mock.baseUrl, model: 'mock/model' } });
			const options = await openOptions(h);
			const newInstall = await optionsState(options);
			await saveKeys(options, { opengateway: 'mock-og' });
			const ogOnly = await optionsState(options);
			await saveKeys(options, { openrouter: 'mock-or' });
			const bothKeys = await optionsState(options);
			await options.locator('#provider').screenshot({ path: png });

			const foldOnce = async () => {
				await h.page.bringToFront();
				await h.navigate(fixtures.wiki);
				await foldBy(h, 1, 3);
				return settled(h, 1, modelFold);
			};
			const first = await foldOnce();
			await options.bringToFront();
			await choose(options, 'openrouter');
			const switched = await optionsState(options);
			const second = await foldOnce();
			await options.bringToFront();
			await choose(options, 'opengateway');
			const third = await foldOnce();

			console.log(`options: new install ${JSON.stringify(newInstall)}, OpenGateway key ${JSON.stringify(ogOnly)}, both keys ${JSON.stringify(bothKeys)}, OpenRouter picked ${JSON.stringify(switched)}`);
			console.log(`Takeaways: OpenGateway ${first.text}; OpenRouter ${second.text}; OpenGateway again ${third.text}`);
			console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
			expect(newInstall).toMatchObject({ checked: 'opengateway', route: 'tfold folds with quick summaries now.' });
			expect(ogOnly).toMatchObject({ checked: 'opengateway', status: 'The OpenGateway key works and is saved.' });
			expect(bothKeys).toMatchObject({ checked: 'opengateway', status: 'The OpenRouter key works and is saved.', route: 'AI summaries come from OpenGateway, and from OpenRouter when OpenGateway is busy.' });
			expect(switched).toMatchObject({
				checked: 'openrouter',
				status: '',
				route: 'AI summaries come from OpenRouter, and from OpenGateway when OpenRouter is busy.',
				model: 'mock/model',
			});
			expect(first.text).toContain('Mock opengateway 1');
			expect(second.text).toContain('Mock openrouter 2');
			expect(third.text).toContain('Mock opengateway 1');
			expect(mock.dialects).toEqual(['opengateway', 'openrouter']);
			expect(workerLines(h, 'fold cache hit')).toHaveLength(1);
			const stored = await h.worker.evaluate(() => chrome.storage.local.get(['providers', 'provider']));
			expect(stored).toEqual({
				providers: {
					chosen: 'opengateway',
					opengateway: { apiKey: 'mock-og', model: 'mock/model', baseUrl: mock.baseUrl },
					openrouter: { apiKey: 'mock-or', model: 'mock/model', baseUrl: mock.baseUrl },
				},
			});
			await options.bringToFront();
			await options.locator('#remove-key').click();
			await expect(options.locator('#status')).toHaveText('The OpenGateway key is removed.');
			const removed = await optionsState(options);
			console.log(`options after the chosen key is removed: ${JSON.stringify(removed)}`);
			expect(removed).toMatchObject({
				checked: 'opengateway',
				route: 'tfold folds with quick summaries now and asks neither service, because OpenGateway comes first and has no key. Save one, or use OpenRouter, whose key is saved.',
			});
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});

	test('lane 5b: nothing chosen, a new reader starts on OpenGateway and a reader with only an OpenRouter key keeps folding there, on every surface and in the request', async ({ h }) => {
		test.setTimeout(90_000);
		const mock = await mockProvider();
		try {
			const at = { baseUrl: mock.baseUrl, model: 'mock/model' };
			const key = (apiKey: string) => ({ ...at, apiKey });
			const cases = [
				{ name: 'no keys', stored: { opengateway: at, openrouter: at }, expected: 'opengateway', dialect: null },
				{ name: 'only an OpenRouter key', stored: { opengateway: at, openrouter: key('mock-or') }, expected: 'openrouter', dialect: 'openrouter' },
				{ name: 'an OpenGateway key', stored: { opengateway: key('mock-og'), openrouter: at }, expected: 'opengateway', dialect: 'opengateway' },
				{ name: 'OpenRouter chosen with both keys', stored: { chosen: 'openrouter', opengateway: key('mock-og'), openrouter: key('mock-or') }, expected: 'openrouter', dialect: 'openrouter' },
				{ name: 'OpenGateway chosen with both keys', stored: { chosen: 'opengateway', opengateway: key('mock-og'), openrouter: key('mock-or') }, expected: 'opengateway', dialect: 'opengateway' },
			] as const;
			const seen: Record<string, unknown> = {};
			for (const { name, stored, expected, dialect } of cases) {
				await seed(h, stored);
				const options = await openOptions(h);
				const { checked } = await optionsState(options);
				await options.close();

				await h.navigate(fixtures.wiki);
				const popup = await h.openPopup();
				const line = await popup.evaluate('[...document.querySelectorAll("#provider-title, #provider-state")].map((el) => el.textContent).join(" | ")');
				await popup.close();

				await foldBy(h, 1, 3);
				const shown = await settled(h, 1, (shown) => modelFold(shown) || badged(shown));
				seen[name] = { checked, line, fold: shown.fold, writer: /Mock (\w+)/.exec(shown.text ?? '')?.[1] ?? null };
				expect(seen[name], name).toMatchObject({ checked: expected, fold: dialect ? 'model' : 'local', writer: dialect });
				expect(line, name).toContain(presets[expected].name);
			}
			console.log(JSON.stringify(seen, null, 1));
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});

	test('lane 5c: a reader who never chose and removes the only OpenRouter key stays on OpenRouter, so the next key they paste goes to the service they meant', async ({ h }) => {
		const mock = await mockProvider();
		try {
			await seed(h, { opengateway: { baseUrl: mock.baseUrl }, openrouter: { apiKey: 'mock-or', baseUrl: mock.baseUrl } });
			const options = await openOptions(h);
			await options.locator('#remove-key').click();
			await expect(options.locator('#status')).toHaveText('The OpenRouter key is removed.');
			expect(await optionsState(options)).toMatchObject({ checked: 'openrouter', route: 'tfold folds with quick summaries now.' });
			await options.locator('#key').fill('mock-or-new');
			await options.locator('#save').click();
			await expect(options.locator('#status')).toHaveText('The OpenRouter key works and is saved.');
			expect(await optionsState(options)).toMatchObject({ checked: 'openrouter', route: 'AI summaries come from OpenRouter.' });
			expect(errors(h)).toEqual([]);
		} finally {
			await mock.close();
		}
	});

	test('lane 6: a chosen provider that drops the connection goes once to the other provider, which answers', async ({ h }) => {
		const dropped = await mockProvider('reset');
		const other = await mockProvider();
		try {
			await seed(h, {
				chosen: 'opengateway',
				opengateway: { apiKey: 'mock-og', baseUrl: dropped.baseUrl, model: 'mock/model' },
				openrouter: { apiKey: 'mock-or', baseUrl: other.baseUrl, model: 'mock/model' },
			});
			await h.navigate(fixtures.wiki);
			await foldBy(h, 1, 3);
			const shown = await settled(h, 1, (shown) => modelFold(shown) || badged(shown));
			console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
			console.log(`the dropped provider saw ${JSON.stringify(dropped.dialects)}, the other saw ${JSON.stringify(other.dialects)}`);
			expect(shown).toMatchObject({ level: '3', fold: 'model', badge: null });
			expect(shown.text).toContain('Mock openrouter 1');
			expect(dropped.dialects).toEqual(['opengateway']);
			expect(other.dialects).toEqual(['openrouter']);
			expect(workerLines(h, 'fold fallback')).toEqual([expect.stringMatching(/^fold fallback to openrouter after opengateway network, TypeError: Failed to fetch, \d+ ms$/)]);
			expect(workerLines(h, 'fold failed')).toEqual([]);
			expect(usages(h).map((usage) => usage.provider)).toEqual(['openrouter']);
		} finally {
			await dropped.close();
			await other.close();
		}
	});
});

function sh(command: string, args: string[]): string {
	const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr}`);
	return result.stdout.trim();
}

async function encode(videoDir: string, mp4: string): Promise<number> {
	const [webm] = (await readdir(videoDir)).filter((name) => name.endsWith('.webm'));
	if (!webm) throw new Error('Playwright wrote no video');
	sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(videoDir, webm), '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
	const { size } = await stat(mp4);
	const seconds = Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]));
	console.log(`${path.basename(mp4)}: ${(size / 1e6).toFixed(2)} MB, ${seconds.toFixed(1)} s`);
	expect(size).toBeLessThan(5e6);
	return seconds;
}

test.describe('video probe', () => {
	test.skip(process.env.TFOLD_PROBE !== 'video', 'TFOLD_PROBE=video records the review video');
	test.skip(ogKey === '', 'OPENGATEWAY_API_KEY is not set');

	test('save an OpenGateway key and fold Korean paragraphs live', async ({ headless }) => {
		test.setTimeout(180_000);
		const videoDir = path.join(outDir, 'video');
		const mp4 = path.join(outDir, 'p5c-opengateway.mp4');
		await rm(videoDir, { recursive: true, force: true });
		await rm(mp4, { force: true });
		const h = await launch({ headless, allowLiveHosts: [ogHost], recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
		try {
			await h.page.setViewportSize({ width: 1280, height: 720 });
			await h.page.addInitScript(() => {
				addEventListener('DOMContentLoaded', () => {
					const caption = document.body.appendChild(document.createElement('div'));
					caption.id = 'tf-caption';
					caption.style.cssText =
						'position:fixed;left:16px;bottom:16px;max-width:1000px;padding:8px 14px;border-radius:8px;background:rgba(20,20,20,.85);color:#fff;font:600 18px system-ui;pointer-events:none;z-index:2147483647';
					caption.textContent = sessionStorage.getItem('tf-caption') ?? '';
				});
			});
			const say = (text: string) =>
				h.page.evaluate((value) => {
					sessionStorage.setItem('tf-caption', value);
					const caption = document.getElementById('tf-caption');
					if (caption) caption.textContent = value;
				}, text);
			const step = async (index: number, steps: number, text: string, hold: number) => {
				await say(text);
				await foldBy(h, index, steps);
				await h.page.waitForTimeout(latchMs + hold);
			};

			await h.navigate(optionsUrl(h));
			await say('tfold settings on a new install: no key yet, so OpenGateway is selected');
			await h.page.waitForTimeout(2500);
			await h.page.locator('#key').fill(ogKey);
			await say('Paste the OpenGateway key and save');
			await h.page.waitForTimeout(1200);
			await h.page.locator('button[type="submit"]').click();
			await expect(h.page.locator('#status')).toHaveText('The OpenGateway key works and is saved.');
			await say('Checked and saved, and the page says so');
			await h.page.waitForTimeout(3000);

			await h.worker.evaluate(() => chrome.storage.local.set({ hintSeen: true }));
			await h.navigate(koWiki);
			await h.page.locator(`${wikiParagraphs} >> nth=1`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
			await h.page.evaluate(() => scrollBy(0, -120));
			await say('Korean Wikipedia, 블랙홀: the first fold of this browser session');
			await h.page.waitForTimeout(1500);
			await say('Fold to Brief: the local fold shows at once, then OpenGateway answers');
			const point = await aim(h, 1);
			const tried = Date.now();
			await h.foldAt(point.x, point.y, 1);
			await settled(h, 1, modelFold);
			const waitedMs = Date.now() - tried;
			const [first] = usages(h);
			await say(`First how: the OpenGateway call took ${first?.ms ?? '?'} ms, and the model fold showed ${waitedMs} ms after the fold began`);
			await h.page.waitForTimeout(3500);
			await step(1, 1, 'Key: one line written by the model, in Korean', 2600);
			await step(1, 1, 'Takeaway', 2200);
			await step(2, 2, 'Fold the next paragraph', 600);
			await settled(h, 2, modelFold);
			await say(usages(h).length === 1 ? 'It came in the same call, so it folded with no wait' : `A second call took ${usages(h).at(-1)?.ms ?? '?'} ms`);
			await h.page.waitForTimeout(2200);
			await step(1, -3, 'Back to Full', 1800);
			await say(`${usages(h).length} OpenGateway calls, reasoning tokens ${usages(h).map((usage) => usage.reasoningTokens).join(', ')}`);
			await h.page.waitForTimeout(2500);
			console.log(`service worker fold lines: ${JSON.stringify(workerLines(h, 'fold '))}`);
			console.log(`first how: the model fold showed ${waitedMs} ms after the first wheel event, the OpenGateway call took ${first?.ms} ms`);
			const cost = usages(h).reduce((sum, usage) => sum + usage.promptTokens * ogPrice.input + usage.completionTokens * ogPrice.output, 0);
			console.log(`${usages(h).length} OpenGateway calls, about $${cost.toFixed(6)} at the list price`);
			expect(usages(h).every((usage) => usage.provider === 'opengateway' && usage.reasoningTokens === 0)).toBe(true);
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
		}
		const seconds = await encode(videoDir, mp4);
		expect(seconds).toBeGreaterThanOrEqual(20);
		expect(seconds).toBeLessThanOrEqual(40);
	});
});
