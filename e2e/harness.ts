import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type CDPSession, type ConsoleMessage, type Page, type Worker } from '@playwright/test';
import { signInUrl, type Account } from '../src/account.ts';
import { startFixtureServer } from './fixture-server.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
export const editionDirs: Record<Edition, string> = { open: path.join(repoRoot, 'dist'), store: path.join(repoRoot, 'dist-store') };
export const extensionDir = editionDirs.store;

export const fixtures = {
	wiki: '/wikipedia-black-hole/',
	arxiv: '/arxiv-2401.04088/',
	react: '/react/',
} as const;

export const foldStepDelta = 60;
const wheelEventsPerStep = 5;
const ctrlModifier = 2;
const controlKey = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };

export type LogEntry = {
	source: 'page' | 'worker';
	type: ReturnType<ConsoleMessage['type']> | 'pageerror';
	text: string;
	url: string;
};
export type BlockState = { id: string; level: number };
export type Point = { x: number; y: number };
export type LaunchOptions = Omit<NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>, 'args' | 'channel' | 'locale'> & {
	allowLiveHosts?: readonly string[];
	lang?: string;
	account?: Account | null;
};

export type Popup = {
	evaluate<T>(expression: string): Promise<T>;
	click(selector: string): Promise<void>;
	colorScheme(scheme: 'light' | 'dark'): Promise<void>;
	screenshot(file: string): Promise<void>;
	close(): Promise<void>;
};

export type Harness = {
	context: BrowserContext;
	page: Page;
	worker: Worker;
	extensionId: string;
	baseURL: string;
	bootMs: number;
	logs: LogEntry[];
	blockedRequests: string[];
	navigate(url: string): Promise<void>;
	pointAt(selector: string): Promise<Point>;
	foldAt(x: number, y: number, steps: number): Promise<void>;
	click(selector: string): Promise<void>;
	press(keys: string): Promise<void>;
	openPopup(tab?: Page): Promise<Popup>;
	tabUrls(): Promise<string[]>;
	readBlocks(): Promise<BlockState[]>;
	inContent<T>(expression: string): Promise<T>;
	showText(title: string, text: string): Promise<void>;
	close(): Promise<void>;
};

// The way a reader away from a Mac folds: the real Control key goes down, the wheel turns, and the key comes up.
export async function foldAt(cdp: CDPSession, x: number, y: number, steps: number): Promise<void> {
	await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...controlKey, modifiers: ctrlModifier });
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: ctrlModifier });
	const deltaY = (Math.sign(steps) * foldStepDelta) / wheelEventsPerStep;
	for (let i = 0; i < Math.abs(steps) * wheelEventsPerStep; i++) {
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: ctrlModifier });
	}
	await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...controlKey });
}

export async function pointAt(page: Page, cdp: CDPSession, selector: string): Promise<Point> {
	const target = page.locator(selector).first();
	await target.scrollIntoViewIfNeeded();
	const point = await target.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const visible = [...range.getClientRects()].filter(
			(rect) => rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight,
		);
		const middle = (visible.length - 1) / 2;
		const nearestMiddleFirst = visible
			.map((rect, index) => ({ rect, distance: Math.abs(index - middle) }))
			.sort((a, b) => a.distance - b.distance)
			.map(({ rect }) => rect);
		for (const rect of [...nearestMiddleFirst, element.getBoundingClientRect()]) {
			const x = rect.left + rect.width / 2;
			const y = rect.top + rect.height / 2;
			if (element.contains(document.elementFromPoint(x, y))) return { x, y };
		}
		return null;
	});
	if (!point) throw new Error(`no visible part of ${selector} is under the pointer`);
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
	return point;
}

async function userDataDirWithDeveloperMode(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), 'tfold-'));
	await mkdir(path.join(dir, 'Default'));
	await writeFile(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
	return dir;
}

type RawCdp = { send(method: string, params?: object): Promise<unknown> };
type BrowserSession = {
	on(event: 'Target.receivedMessageFromTarget', listener: (event: { sessionId: string; message: string }) => void): void;
	detach(): Promise<void>;
};
type TargetInfo = { targetId: string; type: string; url: string };

const browserSchemes = new Set(['chrome:', 'chrome-extension:', 'about:', 'data:']);

export async function launch(options: LaunchOptions = {}, extension = extensionDir): Promise<Harness> {
	const started = performance.now();
	const { allowLiveHosts = [], lang, account = { kind: 'free' }, ...browserOptions } = options;
	const server = await startFixtureServer();
	const userDataDir = await userDataDirWithDeveloperMode();
	const context = await chromium.launchPersistentContext(userDataDir, {
		...browserOptions,
		// Chromium on Linux takes its own language from LANGUAGE, and --lang alone leaves chrome.i18n.getUILanguage() in English.
		...(lang ? { locale: lang, env: { ...process.env, ...browserOptions.env, LANGUAGE: lang } } : {}),
		channel: 'chromium',
		args: [
			`--disable-extensions-except=${extension}`,
			`--load-extension=${extension}`,
			'--disable-quic',
			'--enable-unsafe-extension-debugging',
			// A tab the extension opens can start loading before the context's route sees it, so the website must not resolve.
			`--host-resolver-rules=MAP ${new URL(signInUrl).hostname} ~NOTFOUND`,
			...(lang ? [`--lang=${lang}`] : []),
		],
	});
	const blockedRequests: string[] = [];
	const staysOffline = (url: URL) =>
		url.origin === server.baseURL || browserSchemes.has(url.protocol) || allowLiveHosts.includes(url.hostname);
	await context.route(
		(url) => !staysOffline(url),
		(route) => {
			blockedRequests.push(route.request().url());
			return route.abort('blockedbyclient');
		},
	);
	const logs: LogEntry[] = [];
	context.on('console', (message) => {
		const source = message.worker() ? 'worker' : 'page';
		logs.push({ source, type: message.type(), text: message.text(), url: message.location().url });
	});
	context.on('weberror', (error) => {
		logs.push({ source: 'page', type: 'pageerror', text: error.error().message, url: error.page()?.url() ?? '' });
	});
	const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
	const extensionId = new URL(worker.url()).host;
	const bootMs = Math.round(performance.now() - started);
	console.log(`extension ready ${extensionId} in ${bootMs} ms`);
	const { permissions = [] } = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')) as { permissions?: string[] };
	if (account && permissions.includes('storage')) await worker.evaluate((account) => chrome.storage.local.set({ account }), account);
	const page = context.pages()[0] ?? (await context.newPage());
	const cdp = await context.newCDPSession(page);

	async function inContent<T>(expression: string): Promise<T> {
		const session = await context.newCDPSession(page);
		try {
			const worlds: { id: number; origin: string; auxData?: { frameId?: string } }[] = [];
			session.on('Runtime.executionContextCreated', ({ context: world }) => worlds.push(world));
			await session.send('Runtime.enable');
			const { frameTree } = await session.send('Page.getFrameTree');
			const world = worlds.find(
				(candidate) => candidate.origin === `chrome-extension://${extensionId}` && candidate.auxData?.frameId === frameTree.frame.id,
			);
			if (!world) throw new Error('the content script is not running in the main frame');
			const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
				expression,
				contextId: world.id,
				returnByValue: true,
				awaitPromise: true,
			});
			if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
			return result.value as T;
		} finally {
			await session.detach();
		}
	}

	async function tabUrls(): Promise<string[]> {
		const browser = context.browser();
		if (!browser) throw new Error('the context has no browser to list the tabs of');
		const session = (await browser.newBrowserCDPSession()) as unknown as RawCdp & BrowserSession;
		try {
			const { targetInfos } = (await session.send('Target.getTargets', { filter: [{ type: 'page' }] })) as { targetInfos: TargetInfo[] };
			return targetInfos.map((info) => info.url);
		} finally {
			await session.detach();
		}
	}

	async function openPopup(on: Page = page): Promise<Popup> {
		const browser = context.browser();
		if (!browser) throw new Error('the context has no browser to trigger the toolbar action through');
		const session = (await browser.newBrowserCDPSession()) as unknown as RawCdp & BrowserSession;
		const targets = async (filter?: object[]) => ((await session.send('Target.getTargets', filter && { filter })) as { targetInfos: TargetInfo[] }).targetInfos;
		const tab = (await targets([{ type: 'tab' }])).find((info) => info.url === on.url());
		if (!tab) throw new Error(`no tab target shows ${on.url()}`);
		await session.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId });
		const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
		let popup: TargetInfo | undefined;
		for (const started = Date.now(); !popup && Date.now() - started < 5000; await new Promise((resolve) => setTimeout(resolve, 50))) {
			popup = (await targets()).find((info) => info.url === popupUrl);
		}
		if (!popup) throw new Error('the toolbar action opened no popup');
		// Playwright does not adopt the popup's target, so commands reach it through the browser session.
		const { sessionId } = (await session.send('Target.attachToTarget', { targetId: popup.targetId, flatten: false })) as { sessionId: string };
		const pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();
		let lastId = 0;
		session.on('Target.receivedMessageFromTarget', (event) => {
			if (event.sessionId !== sessionId) return;
			const reply = JSON.parse(event.message) as { id?: number; result?: unknown; error?: { message: string } };
			const waiting = reply.id === undefined ? undefined : pending.get(reply.id);
			if (!waiting || reply.id === undefined) return;
			pending.delete(reply.id);
			if (reply.error) waiting.reject(new Error(reply.error.message));
			else waiting.resolve(reply.result);
		});
		const send = <T>(method: string, params: object = {}) =>
			new Promise<T>((resolve, reject) => {
				const id = ++lastId;
				pending.set(id, { resolve, reject });
				session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
			});
		const evaluate = async <T>(expression: string): Promise<T> => {
			const { result, exceptionDetails } = await send<{ result: { value: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
				'Runtime.evaluate',
				{ expression, returnByValue: true, awaitPromise: true },
			);
			if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
			return result.value as T;
		};
		await evaluate(`new Promise((resolve) => {
			const ready = () => performance.getEntriesByName('tfold-ready').length > 0;
			const poll = () => (ready() ? resolve(true) : setTimeout(poll, 20));
			poll();
		})`);
		return {
			evaluate,
			click: async (selector) => {
				const box = await evaluate<{ x: number; y: number } | null>(
					`(() => { const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null; })()`,
				);
				if (!box) throw new Error(`the popup has no ${selector}`);
				for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 });
			},
			colorScheme: async (scheme) => {
				await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
			},
			screenshot: async (file) => {
				await evaluate('Promise.all(document.getAnimations().map((animation) => animation.finished))');
				await new Promise((resolve) => setTimeout(resolve, 250));
				const { data } = await send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
				await writeFile(file, Buffer.from(data, 'base64'));
			},
			close: async () => {
				const closed = send('Runtime.evaluate', { expression: 'close()' }).catch(() => undefined);
				await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
				await session.detach().catch(() => undefined);
			},
		};
	}

	return {
		context,
		page,
		worker,
		extensionId,
		baseURL: server.baseURL,
		bootMs,
		logs,
		blockedRequests,
		navigate: async (url) => {
			await page.goto(new URL(url, server.baseURL).href, { waitUntil: 'load' });
		},
		pointAt: (selector) => pointAt(page, cdp, selector),
		foldAt: (x, y, steps) => foldAt(cdp, x, y, steps),
		click: async (selector) => {
			const { x, y } = await pointAt(page, cdp, selector);
			await page.mouse.click(x, y);
		},
		press: (keys) => page.keyboard.press(keys),
		openPopup,
		tabUrls,
		readBlocks: () => inContent<BlockState[]>('globalThis.__tfold.readBlocks()'),
		inContent,
		showText: async (title, text) => {
			await page.setContent(
				'<style>body{font:15px/1.45 monospace;margin:24px}pre{white-space:pre-wrap;word-break:break-all}</style><h1></h1><pre></pre>',
			);
			await page.locator('h1').evaluate((element, value) => (element.textContent = value), title);
			await page.locator('pre').evaluate((element, value) => (element.textContent = value), text);
		},
		close: async () => {
			await context.close();
			await server.close();
			await rm(userDataDir, { recursive: true, force: true });
			if (blockedRequests.length > 0) {
				throw new Error(`requests left the fixture server and were aborted:\n${blockedRequests.join('\n')}`);
			}
		},
	};
}
