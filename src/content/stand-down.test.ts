import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { defaultShortcuts } from '../shortcuts.ts';

let browser: Browser;
let contentScript: string;

beforeAll(async () => {
	const bundle = build({ entryPoints: [path.join(import.meta.dirname, 'index.ts')], bundle: true, format: 'iife', target: 'chrome120', define: { TFOLD_EDITION: '"store"', TFOLD_DEV: 'false' }, write: false });
	[browser, contentScript] = await Promise.all([chromium.launch(), bundle.then((result) => result.outputFiles[0]?.text ?? '')]);
});

afterAll(async () => {
	await browser.close();
});

type Copy = { page: Page; box: { x: number; y: number; width: number; height: number }; hint: () => Promise<string[]>; cutOff: () => Promise<void> };
type SettingsWatch = {
	settingReads: { resolve: (stored: object) => void; reject: (error: Error) => void }[];
	settingListeners: ((changes: object, area: string) => void)[];
};
type Tf = { __tfold: { readBlocks(): { id: string }[]; setLevel(id: string, level: number): void } };
type Watching = { watching: { observers: Set<MutationObserver>; schemes: Set<string>; listeners: Set<string>; styleReads: number } };

async function copyOnPage(): Promise<Copy> {
	const page = await browser.newPage();
	await page.clock.install({ time: 0 });
	await page.clock.pauseAt(1000);
	await page.setContent(
		'<main style="padding:200px 40px"><p>A paragraph long enough to fold, under a pointer that rests on it until the hint about folding shows up above it.</p></main>',
	);
	await page.evaluate((shortcuts) => {
		const replies: Record<string, unknown> = { page: { on: true, hint: true, shortcuts, scrollModifier: 'ctrl' }, 'claim-hint': true, fold: { ok: false, error: 'no-key' } };
		const sendMessage = (message: { type: string }) => Promise.resolve(replies[message.type]);
		const watch: SettingsWatch = { settingReads: [], settingListeners: [] };
		Object.assign(globalThis, watch);
		const storage = {
			sync: { get: () => new Promise((resolve, reject) => watch.settingReads.push({ resolve, reject })) },
			onChanged: { addListener: (listener: SettingsWatch['settingListeners'][number]) => watch.settingListeners.push(listener) },
		};
		Object.assign(globalThis, { chrome: { runtime: { id: 'tfold', sendMessage, onMessage: { addListener() {} } }, i18n: { getUILanguage: () => 'en' }, storage } });
	}, defaultShortcuts);
	await page.evaluate(() => {
		const watching = { observers: new Set<MutationObserver>(), schemes: new Set<string>(), listeners: new Set<string>(), styleReads: 0 };
		Object.assign(globalThis, { watching });
		const pageEvents = new Set(['resize', 'load', 'transitionend', 'transitioncancel', 'animationend', 'animationcancel']);
		for (const target of [window, document]) {
			const [add, remove] = [target.addEventListener.bind(target), target.removeEventListener.bind(target)];
			target.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
				if (pageEvents.has(type)) watching.listeners.add(type);
				add(type, listener, options);
			};
			target.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
				watching.listeners.delete(type);
				remove(type, listener, options);
			};
		}
		globalThis.MutationObserver = class extends MutationObserver {
			override observe(...args: Parameters<MutationObserver['observe']>) {
				if (args[0] === document.documentElement) watching.observers.add(this);
				super.observe(...args);
			}
			override disconnect() {
				watching.observers.delete(this);
				super.disconnect();
			}
		};
		const media = matchMedia.bind(globalThis);
		globalThis.matchMedia = (query) => {
			const list = media(query);
			const [add, remove] = [list.addEventListener.bind(list), list.removeEventListener.bind(list)];
			list.addEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
				watching.schemes.add(query);
				add(type, listener);
			};
			list.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
				watching.schemes.delete(query);
				remove(type, listener);
			};
			return list;
		};
		const read = getComputedStyle;
		globalThis.getComputedStyle = (...args) => {
			watching.styleReads++;
			return read(...args);
		};
	});
	await page.addScriptTag({ content: contentScript });
	const box = await page.locator('p').boundingBox();
	if (!box) throw new Error('the paragraph has no box');
	return {
		page,
		box,
		hint: () => page.evaluate(() => [...document.querySelectorAll('tf-hint')].map((host) => getComputedStyle(host).visibility)),
		cutOff: () =>
			page.evaluate(() => {
				const { chrome } = globalThis as unknown as { chrome: { runtime: { id?: string }; i18n?: unknown; storage?: unknown } };
				delete chrome.runtime.id;
				delete chrome.i18n;
				delete chrome.storage;
			}),
	};
}

test('a copy that Chrome cuts off from tfold takes its hint off the page at the next pointer move', async () => {
	const { page, box, hint, cutOff } = await copyOnPage();
	await page.mouse.move(box.x + 40, box.y + box.height / 2);
	await page.clock.runFor(1000);
	const shown = await hint();

	await cutOff();
	await page.mouse.move(box.x + 80, box.y + box.height / 2);
	expect({ shown, cutOff: await hint() }).toEqual({ shown: ['visible'], cutOff: [] });
	await page.close();
});

test('a copy that Chrome cuts off while the pointer rests shows no hint and does not ask Chrome for its text', async () => {
	const { page, box, hint, cutOff } = await copyOnPage();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.mouse.move(box.x + 40, box.y + box.height / 2);
	await cutOff();
	await page.clock.runFor(1000);
	expect({ hint: await hint(), errors }).toEqual({ hint: [], errors: [] });
	await page.close();
});

test.each<[string, () => void]>([
	['its reads of the settings answer', () => (globalThis as unknown as SettingsWatch).settingReads.forEach((read) => read.resolve({ autoTranslate: true }))],
	['its reads of the settings fail', () => (globalThis as unknown as SettingsWatch).settingReads.forEach((read) => read.reject(new Error('Extension context invalidated.')))],
	[
		'the settings change',
		() => (globalThis as unknown as SettingsWatch).settingListeners.forEach((listener) => listener({ autoTranslate: { newValue: true }, readerLanguage: { newValue: 'ko' } }, 'sync')),
	],
])('a copy that Chrome cuts off throws nothing when %s', async (_, happen) => {
	const { page, cutOff } = await copyOnPage();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await cutOff();
	await page.evaluate(happen);
	await page.waitForTimeout(100);
	expect(errors).toEqual([]);
	await page.close();
});

const foldFirstBlock = (page: Page) =>
	page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [block] = tf.readBlocks();
		if (block) tf.setLevel(block.id, 2);
	});

const setTheme = (page: Page, theme: string) => page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);

for (const [name, firstChange] of [
	['an attribute of the page', (page: Page) => setTheme(page, 'dark')],
	['the color scheme', (page: Page) => page.emulateMedia({ colorScheme: 'dark' })],
	['a fade around it stops', (page: Page) => page.evaluate(() => void document.body.dispatchEvent(new TransitionEvent('transitionend', { bubbles: true })))],
	['a fade around it is canceled', (page: Page) => page.evaluate(() => void document.body.dispatchEvent(new TransitionEvent('transitioncancel', { bubbles: true })))],
	['a keyframe fade around it stops', (page: Page) => page.evaluate(() => void document.body.dispatchEvent(new AnimationEvent('animationend', { bubbles: true })))],
	['a keyframe fade around it is canceled', (page: Page) => page.evaluate(() => void document.body.dispatchEvent(new AnimationEvent('animationcancel', { bubbles: true })))],
	['the window', (page: Page) => page.setViewportSize({ width: 900, height: 600 })],
	['a style sheet that loads', (page: Page) => page.evaluate(() => void document.querySelector('style')?.dispatchEvent(new Event('load')))],
] as const) {
	test(`a copy cut off with a failed fold on screen puts the paragraph back when ${name} changes, does not ask Chrome for its text and stops watching the page`, async () => {
		const { page, cutOff } = await copyOnPage();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await foldFirstBlock(page);
		await expect.poll(() => page.evaluate(() => document.querySelector('[data-tf-badge]') !== null)).toBe(true);
		const folded = await page.evaluate(() => {
			const { observers, listeners } = (globalThis as unknown as Watching).watching;
			return { observers: observers.size, listeners: [...listeners].sort() };
		});

		await cutOff();
		await page.evaluate(() => {
			(globalThis as unknown as Watching).watching.styleReads = 0;
		});
		await firstChange(page);
		await page.clock.runFor(100);
		await expect.poll(() => page.evaluate(() => document.querySelectorAll('[data-tfold-overlay]').length)).toBe(0);
		await setTheme(page, 'light');
		await page.emulateMedia({ colorScheme: 'light' });
		const left = await page.evaluate(() => {
			const { observers, schemes, listeners, styleReads } = (globalThis as unknown as Watching).watching;
			return {
				overlays: document.querySelectorAll('[data-tfold-overlay]').length,
				hidden: document.querySelectorAll('[data-tfold-hidden]').length,
				observers: observers.size,
				schemes: schemes.size,
				listeners: [...listeners],
				styleReads,
			};
		});
		expect(folded).toEqual({ observers: 2, listeners: ['animationcancel', 'animationend', 'load', 'resize', 'transitioncancel', 'transitionend'] });
		expect({ ...left, errors }).toEqual({ overlays: 0, hidden: 0, observers: 0, schemes: 0, listeners: [], styleReads: 0, errors: [] });
		await page.close();
	});
}

test('a fade that stops reads a fold once for however many properties stopped with it, and one that stops elsewhere reads nothing', async () => {
	const { page } = await copyOnPage();
	await page.clock.resume();
	await page.addStyleTag({ content: '.night { color: #eee; background-color: #111; }' });
	await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="elsewhere"></div>'));
	await foldFirstBlock(page);
	const readsThrough = (selector: string, transition: string, stops: number) =>
		page.evaluate(
			async ({ selector, transition, stops }) => {
				const { watching } = globalThis as unknown as Watching;
				const el = document.querySelector<HTMLElement>(selector);
				if (!el) throw new Error(`no ${selector}`);
				el.style.transition = transition;
				void getComputedStyle(el).color;
				const stopped = new Promise<void>((resolve) => {
					let left = stops;
					document.addEventListener('transitionend', () => {
						if (--left === 0) resolve();
					});
				});
				el.classList.toggle('night');
				await Promise.resolve();
				watching.styleReads = 0;
				await stopped;
				for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
				return watching.styleReads;
			},
			{ selector, transition, stops },
		);
	const oneProperty = await readsThrough('body', 'color 50ms', 1);
	const twoProperties = await readsThrough('body', 'color 50ms, background-color 50ms', 2);
	expect(oneProperty).toBeGreaterThan(0);
	expect(twoProperties).toBe(oneProperty);
	expect(await readsThrough('#elsewhere', 'color 50ms, background-color 50ms', 2)).toBe(0);
	await page.close();
});

test('a write to the overlay of another copy inside a folded block is no change of its look, while a write to any other element inside it is', async () => {
	const { page } = await copyOnPage();
	await page.clock.resume();
	await page.evaluate(() => {
		const paragraph = document.querySelector('p');
		paragraph?.insertAdjacentHTML('beforeend', '<span id="theirs" data-tfold-overlay="other"></span><span id="page"></span>');
	});
	await foldFirstBlock(page);
	await expect.poll(() => page.evaluate(() => document.querySelector('[data-tf-badge]') !== null && document.querySelector('tfold-ghosts') === null)).toBe(true);
	const readsAfter = (id: string) =>
		page.evaluate(async (id) => {
			const { watching } = globalThis as unknown as Watching;
			watching.styleReads = 0;
			document.getElementById(id)?.setAttribute('data-written', '');
			for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
			return watching.styleReads;
		}, id);
	expect(await readsAfter('theirs')).toBe(0);
	expect(await readsAfter('page')).toBeGreaterThan(0);
	await page.close();
});
