import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import { maxRun } from '../../src/content/hold-model.ts';
import { failedWaitMs } from '../../src/messages.ts';
import { en } from '../../src/strings/en.ts';
import { ko } from '../../src/strings/ko.ts';
import { editionDirs, extensionDir, fixtures, launch, type Harness, type Point } from '../harness.ts';
import { expect, test } from '../lane.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p9');
const sweepPage = '/sweep/';
const feed = '/x-like/';
const alt = 1;
const shift = 8;
const latchedMs = 450;
const beatMs = 150;

const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const session = (h: Harness) => h.context.newCDPSession(h.page);

async function open(h: Harness, url = sweepPage): Promise<void> {
	await h.navigate(url);
	await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
	await h.readBlocks();
	await h.page.waitForTimeout(150);
}

const tall = (h: Harness) => h.page.setViewportSize({ width: 1280, height: 3400 });

const levelOf = (h: Harness, id: string) => h.inContent<number | null>(`globalThis.__tfold.blockAt(document.getElementById(${JSON.stringify(id)}))?.level ?? null`);

const levelsOf = (h: Harness, ids: readonly string[]) => Promise.all(ids.map((id) => levelOf(h, id)));

const ps = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `p${from + i}`);

type Box = { left: number; right: number; top: number; bottom: number; height: number };

const barBox = (h: Harness) =>
	h.page.evaluate(() => {
		const bar = document.querySelector('tf-bar')?.shadowRoot?.querySelector<HTMLElement>('.bar');
		if (bar?.dataset.on === undefined) return null;
		const { left, right, top, bottom, height } = bar.getBoundingClientRect();
		return { left, right, top, bottom, height };
	});

const barIsOn = async (h: Harness) => (await barBox(h)) !== null;

const barCount = (h: Harness) => h.page.evaluate(() => [...document.querySelectorAll('tf-bar')].filter((host) => host.shadowRoot?.querySelector('.bar[data-on]')).length);

const tipOf = (h: Harness) =>
	h.page.evaluate(() => {
		const tip = document.querySelector('tf-bar')?.shadowRoot?.querySelector<HTMLElement>('.tip');
		return tip && !tip.hidden ? tip.textContent : null;
	});

const shownBox = (page: Page, id: string) =>
	page.evaluate((id) => {
		const el = document.getElementById(id) as Element;
		const shown = el.hasAttribute('data-tfold-hidden') ? (el.nextElementSibling as Element) : el;
		const { left, right, top, bottom, height } = shown.getBoundingClientRect();
		return { left, right, top, bottom, height };
	}, id);

const centerOf = async (h: Harness, id: string): Promise<Point> => {
	const { left, right, top, bottom } = await shownBox(h.page, id);
	return { x: (left + right) / 2, y: (top + bottom) / 2 };
};

const overId = async (h: Harness, id: string) => {
	const { x, y } = await centerOf(h, id);
	await h.page.mouse.move(x, y);
};

// The bar runs from the top of the first to the bottom of the last, cut at the window.
const barSpans = async (h: Harness, first: string, last: string): Promise<boolean> => {
	const [bar, from, to, height] = [await barBox(h), await shownBox(h.page, first), await shownBox(h.page, last), await h.page.evaluate(() => innerHeight)];
	return bar !== null && Math.abs(bar.top - Math.max(from.top, 0)) <= 1 && Math.abs(bar.bottom - Math.min(to.bottom, height)) <= 1;
};

const expectBar = (h: Harness, first: string, last = first) => expect.poll(() => barSpans(h, first, last), { message: `the bar runs from ${first} to ${last}` }).toBe(true);

const keys = {
	down: async (h: Harness, ...names: string[]) => {
		for (const name of names) await h.page.keyboard.down(name);
	},
	up: async (h: Harness, ...names: string[]) => {
		for (const name of names) await h.page.keyboard.up(name);
	},
};
const optionShift = ['Alt', 'Shift'];

const letGo = async (h: Harness, ...names: string[]) => {
	await keys.up(h, ...names);
	await expect.poll(() => barIsOn(h), { message: 'letting go takes the bar away' }).toBe(false);
};

const logWheels = (h: Harness) =>
	h.page.evaluate(() => {
		const w = window as unknown as { wheels: { prevented: boolean }[] };
		w.wheels = [];
		addEventListener('wheel', (event) => {
			const wheel = { prevented: false };
			w.wheels.push(wheel);
			setTimeout(() => (wheel.prevented = event.defaultPrevented));
		});
	});

const takeWheels = (h: Harness) =>
	h.page.evaluate(async () => {
		const w = window as unknown as { wheels: { prevented: boolean }[] };
		await new Promise((resolve) => setTimeout(resolve));
		return w.wheels.splice(0);
	});

async function setScrollKey(h: Harness, key: 'meta' | 'ctrl' | 'alt' | 'off'): Promise<void> {
	await h.worker.evaluate((key) => chrome.storage.local.set({ scrollModifier: key }), key);
	await open(h);
}

const barLog = (h: Harness) =>
	h.page.evaluate(() => {
		const w = window as unknown as { barLog: { on: boolean; at: number }[]; pressed: Record<string, number>; released: Record<string, number> };
		w.barLog = [];
		w.pressed = {};
		w.released = {};
		let was = false;
		const tick = () => {
			const on = document.querySelector('tf-bar')?.shadowRoot?.querySelector('.bar[data-on]') != null;
			if (on !== was) {
				w.barLog.push({ on, at: performance.now() });
				was = on;
			}
			requestAnimationFrame(tick);
		};
		tick();
		addEventListener('keydown', (event) => (w.pressed[event.key] = performance.now()), true);
		addEventListener('keyup', (event) => (w.released[event.key] = performance.now()), true);
	});

const readLog = (h: Harness) =>
	h.page.evaluate(() => {
		const w = window as unknown as { barLog: { on: boolean; at: number }[]; pressed: Record<string, number>; released: Record<string, number> };
		return { barLog: w.barLog.splice(0), pressed: { ...w.pressed }, released: { ...w.released } };
	});

test.describe('a pinch belongs to the browser', () => {
	async function pinchOverParagraph(h: Harness, hold: string[] = []): Promise<{ scale: number; wheels: number; prevented: number; folded: number }> {
		await h.navigate(sweepPage);
		await h.page.waitForTimeout(200);
		await logWheels(h);
		const cdp = await session(h);
		const point = await h.pointAt('#p2');
		await keys.down(h, ...hold);
		await cdp.send('Input.synthesizePinchGesture', { ...point, scaleFactor: 1.5, relativeSpeed: 800, gestureSourceType: 'mouse' });
		await h.page.waitForTimeout(latchedMs);
		await keys.up(h, ...hold);
		const scale = await h.page.evaluate(() => Math.round((visualViewport?.scale ?? 1) * 100) / 100);
		const wheels = await takeWheels(h);
		const folded = await h.page.locator('[data-tfold-overlay]').count();
		await cdp.send('Input.synthesizePinchGesture', { x: point.x / 1.5, y: point.y / 1.5, scaleFactor: 1 / 1.5, relativeSpeed: 800, gestureSourceType: 'mouse' });
		await h.page.waitForTimeout(latchedMs);
		await cdp.detach();
		return { scale, wheels: wheels.length, prevented: wheels.filter((wheel) => wheel.prevented).length, folded };
	}

	test('lane 1: a real pinch over a paragraph zooms exactly as with no extension, with nothing prevented and nothing folded, in the open and store editions, with or without a key held', async ({ headless }) => {
		test.setTimeout(180_000);
		const nothing = await mkdtemp(path.join(tmpdir(), 'tfold-nothing-'));
		await writeFile(path.join(nothing, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'nothing', version: '1', background: { service_worker: 'w.js' } }));
		await writeFile(path.join(nothing, 'w.js'), '');
		const seen: Record<string, unknown> = {};
		const measure = async (name: string, dist: string, account: { kind: 'free' } | null) => {
			const h = await launch({ headless, account }, dist);
			try {
				const plain = await pinchOverParagraph(h);
				seen[name] = plain;
				if (dist === nothing) return plain;
				const holding = await pinchOverParagraph(h, optionShift);
				seen[`${name}, holding the shortcut keys`] = holding;
				await h.worker.evaluate(() => chrome.storage.local.set({ scrollModifier: 'meta' }));
				const withMeta = await pinchOverParagraph(h, ['Meta']);
				seen[`${name}, holding Cmd`] = withMeta;
				expect(errors(h), name).toEqual([]);
				return plain;
			} finally {
				await h.close();
			}
		};
		const bare = await measure('no extension', nothing, null);
		for (const [name, dist] of [['open', editionDirs.open], ['store', editionDirs.store]] as const) await measure(name, dist, { kind: 'free' });
		await rm(nothing, { recursive: true, force: true });
		console.log(JSON.stringify(seen));
		expect(bare.scale, 'a pinch zooms with no extension').toBeGreaterThan(1.4);
		expect(bare.prevented).toBe(0);
		for (const [name, result] of Object.entries(seen)) {
			expect.soft((result as { scale: number }).scale, `${name} zooms as with no extension`).toBe(bare.scale);
			expect.soft((result as { prevented: number }).prevented, `${name} prevents nothing`).toBe(0);
			expect.soft((result as { folded: number }).folded, `${name} folds nothing`).toBe(0);
			expect.soft((result as { wheels: number }).wheels, `${name} reaches the page`).toBeGreaterThan(0);
		}
	});
});

test.describe('the bar shows while the keys are held', () => {
	test('lane 2: with no pointer yet it marks the paragraph with focus, then the one nearest the middle, and it goes to the nearest paragraph in the column from a gap, a heading, a short paragraph or a picture', async ({ h }) => {
		await tall(h);
		await open(h);
		const nearestToMiddle = await h.page.evaluate(() => {
			const y = innerHeight / 2;
			return [...document.querySelectorAll('main p[id^="p"]')]
				.map((el) => ({ id: el.id, box: el.getBoundingClientRect() }))
				.map(({ id, box }) => ({ id, distance: Math.max(box.top - y, 0, y - box.bottom) }))
				.sort((a, b) => a.distance - b.distance)[0]?.id as string;
		});
		await keys.down(h, ...optionShift);
		await expectBar(h, nearestToMiddle);
		await letGo(h, ...optionShift);

		await h.page.evaluate(() => {
			const el = document.getElementById('p5') as HTMLElement;
			el.tabIndex = 0;
			el.focus();
		});
		await keys.down(h, ...optionShift);
		await expectBar(h, 'p5');
		await letGo(h, ...optionShift);
		await h.page.evaluate(() => (document.activeElement as HTMLElement).blur());

		await keys.down(h, ...optionShift);
		await overId(h, 'p2');
		await expectBar(h, 'p2');
		await letGo(h, ...optionShift);

		const positions: [string, () => Promise<Point>, string][] = [
			['a gap, nearer the paragraph below', async () => ({ x: (await centerOf(h, 'p2')).x, y: (await shownBox(h.page, 'p2')).top - 2 }), 'p2'],
			['a gap, nearer the paragraph above', async () => ({ x: (await centerOf(h, 'p2')).x, y: (await shownBox(h.page, 'p1')).bottom + 2 }), 'p1'],
			['a heading', () => centerOf(h, 'heading'), 'p4'],
			['a short paragraph', () => centerOf(h, 'short'), 'p2'],
			['the top of a picture', async () => ({ x: (await centerOf(h, 'photo')).x, y: (await shownBox(h.page, 'photo')).top + 4 }), 'p5'],
			['the bottom of a picture', async () => ({ x: (await centerOf(h, 'photo')).x, y: (await shownBox(h.page, 'photo')).bottom - 4 }), 'p6'],
		];
		for (const [where, point, expected] of positions) {
			const { x, y } = await point();
			await h.page.mouse.move(x, y);
			await keys.down(h, ...optionShift);
			await expectBar(h, expected);
			console.log(`pointer on ${where}: bar on ${expected}`);
			await letGo(h, ...optionShift);
		}

		await h.page.evaluate(() => {
			const side = document.getElementById('side') as HTMLElement;
			side.style.marginTop = `${(document.getElementById('photo') as HTMLElement).getBoundingClientRect().top - side.getBoundingClientRect().top}px`;
		});
		const photo = await shownBox(h.page, 'photo');
		await h.page.mouse.move(photo.right - 4, (photo.top + photo.bottom) / 2);
		await keys.down(h, ...optionShift);
		await expect.poll(async () => (await barSpans(h, 'p5', 'p5')) || barSpans(h, 'p6', 'p6'), { message: 'a note beside the picture is nearer, and a note is not this column' }).toBe(true);
		await letGo(h, ...optionShift);
		expect(errors(h)).toEqual([]);
	});

	test('lane 3: the keys read from pointer events and wheel events alone, with no key event, bring the bar up and follow the reader\'s own shortcut', async ({ h }) => {
		test.setTimeout(120_000);
		await open(h);
		const cdp = await session(h);
		const point = await centerOf(h, 'p2');
		const held = alt | shift;
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 1, y: point.y, modifiers: held });
		await h.page.waitForTimeout(100);
		expect(await barIsOn(h), 'a pointer move carries the keys').toBe(true);
		await expectBar(h, 'p2');
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 2, y: point.y });
		await expect.poll(() => barIsOn(h), { message: 'a pointer move with none takes it away' }).toBe(false);

		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 1, modifiers: held });
		await expect.poll(() => barIsOn(h), { message: 'a wheel carries the keys' }).toBe(true);
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 1 });
		await expect.poll(() => barIsOn(h), { message: 'a wheel with none takes it away' }).toBe(false);

		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 1, modifiers: 2 });
		await h.page.waitForTimeout(beatMs + 100);
		expect(await barIsOn(h), 'Control set on a wheel with no key seen does not count as held').toBe(false);

		await h.worker.evaluate(() => chrome.storage.local.set({ shortcuts: { fold: { code: 'KeyK', ctrl: true, alt: false, shift: true, meta: false }, unfold: { code: 'KeyL', ctrl: true, alt: false, shift: true, meta: false } } }));
		await h.worker.evaluate(async () => {
			const tabs = await chrome.tabs.query({});
			await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id as number, { type: 'shortcuts' }).catch(() => undefined)));
		});
		await h.page.waitForTimeout(200);
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 3, y: point.y, modifiers: held });
		await h.page.waitForTimeout(100);
		expect(await barIsOn(h), 'the old keys no longer count').toBe(false);
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 4, y: point.y, modifiers: 2 | shift });
		await expect.poll(() => barIsOn(h), { message: 'the bar follows a rebound shortcut' }).toBe(true);
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 5, y: point.y });
		expect(errors(h)).toEqual([]);
	});

	test('lane 4: with nothing on screen the bar waits, and comes up as soon as a paragraph is there', async ({ h }) => {
		test.setTimeout(120_000);
		await h.navigate(sweepPage);
		await h.readBlocks();
		await h.page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
		await h.page.mouse.move(400, 300);
		await keys.down(h, ...optionShift);
		await h.page.waitForTimeout(250);
		const empty = await barIsOn(h);
		await h.page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
		await h.page.mouse.move(420, 320);
		await h.page.waitForTimeout(400);
		const seen = await barIsOn(h);
		await keys.up(h, ...optionShift);
		expect({ empty, seen }, 'nothing to mark, then a paragraph').toEqual({ empty: false, seen: true });
	});

	test('lane 5: no bar in a focused field, with text selected, behind a modal, on a site turned off, or signed out', async ({ h, headless }) => {
		test.setTimeout(120_000);
		await open(h);
		await overId(h, 'p2');
		const noBar = async (why: string) => {
			await keys.down(h, ...optionShift);
			await overId(h, 'p1');
			await h.page.waitForTimeout(120);
			expect.soft(await barIsOn(h), why).toBe(false);
			await keys.up(h, ...optionShift);
		};
		await h.page.locator('#field').focus();
		await noBar('a focused field');
		await h.page.evaluate(() => {
			(document.activeElement as HTMLElement).blur();
			scrollTo({ top: 0, behavior: 'instant' });
		});

		await h.page.evaluate(() => getSelection()?.selectAllChildren(document.getElementById('p3') as Element));
		await noBar('selected text');
		await h.page.evaluate(() => getSelection()?.removeAllRanges());

		await h.page.evaluate(() => {
			document.body.insertAdjacentHTML('beforeend', '<dialog id="laid"><p>Are you sure about the pier?</p></dialog>');
			(document.getElementById('laid') as HTMLDialogElement).showModal();
		});
		await noBar('behind a modal');
		await h.page.evaluate(() => document.getElementById('laid')?.remove());

		await overId(h, 'p2');
		await keys.down(h, ...optionShift);
		await expectBar(h, 'p2');
		await h.page.evaluate(() => {
			document.body.insertAdjacentHTML('beforeend', '<div id="laid" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div>');
		});
		await expect.poll(() => barIsOn(h), { message: 'a modal that opens over a held bar takes it away' }).toBe(false);
		await h.page.keyboard.press('ArrowDown');
		expect(await levelOf(h, 'p2'), 'and the keys fold nothing behind it').toBe(0);
		await h.page.evaluate(() => document.getElementById('laid')?.remove());
		await keys.up(h, ...optionShift);

		await logWheels(h);
		await overId(h, 'p2');
		await keys.down(h, 'Control');
		await h.page.waitForTimeout(beatMs + 60);
		await expectBar(h, 'p2');
		await h.page.evaluate(() => {
			document.body.insertAdjacentHTML('beforeend', '<div id="laid" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div>');
		});
		await expect.poll(() => barIsOn(h)).toBe(false);
		await h.page.mouse.wheel(0, 120);
		await h.page.waitForTimeout(latchedMs);
		await keys.up(h, 'Control');
		expect(await levelOf(h, 'p2'), 'a wheel folds nothing behind it either').toBe(0);
		expect((await takeWheels(h)).some((wheel) => wheel.prevented), 'and stays with the modal').toBe(false);
		await h.page.evaluate(() => document.getElementById('laid')?.remove());

		await h.worker.evaluate((host) => chrome.storage.local.set({ disabledSites: [host] }), new URL(h.page.url()).hostname);
		await h.page.reload();
		await h.page.waitForTimeout(300);
		await noBar('a site turned off');
		expect(await h.page.locator('tf-bar').count(), 'not even a host').toBe(0);
		expect(errors(h)).toEqual([]);

		const out = await launch({ headless, account: { kind: 'signedOut' } }, editionDirs.store);
		try {
			await out.navigate(sweepPage);
			await out.page.waitForTimeout(300);
			const { x, y } = await centerOf(out, 'p2');
			await out.page.mouse.move(x, y);
			await keys.down(out, ...optionShift);
			await out.page.mouse.move(x + 5, y);
			await out.page.waitForTimeout(150);
			expect(await barIsOn(out), 'signed out').toBe(false);
			await keys.up(out, ...optionShift);
		} finally {
			await out.close();
		}
	});
});

test.describe('one key held alone waits', () => {
	for (const [name, key, setting] of [['Cmd', 'Meta', 'meta'], ['Ctrl', 'Control', 'ctrl']] as const) {
		test(`lane 6, ${name}: held alone it shows the bar about ${beatMs} ms later, and Cmd+C, Cmd+Tab and Cmd+click show nothing, while the shortcut keys show it at once`, async ({ h }) => {
			test.setTimeout(90_000);
			await setScrollKey(h, setting);
			await barLog(h);
			await overId(h, 'p2');

			const delays: number[] = [];
			const hides: number[] = [];
			for (let i = 0; i < 5; i++) {
				await keys.down(h, key);
				await h.page.waitForTimeout(beatMs + 150);
				await keys.up(h, key);
				await h.page.waitForTimeout(80);
				const { barLog: log, pressed, released } = await readLog(h);
				const [shown, gone] = log;
				expect(shown?.on, `held ${i}`).toBe(true);
				expect(gone?.on, `released ${i}`).toBe(false);
				delays.push(Math.round((shown?.at ?? 0) - (pressed[key] ?? 0)));
				hides.push(Math.round((gone?.at ?? 0) - (released[key] ?? 0)));
			}
			console.log(`${name} alone to the bar, ms: ${delays.join(', ')}; the key up to no bar, ms: ${hides.join(', ')}`);
			const middle = (values: number[]) => [...values].sort((a, b) => a - b)[2] ?? 0;
			for (const delay of delays) expect(delay, 'not before the wait').toBeGreaterThanOrEqual(beatMs);
			expect(middle(delays), 'soon after the wait').toBeLessThanOrEqual(beatMs + 60);
			expect(middle(hides), 'gone within a couple of frames of the key coming up').toBeLessThanOrEqual(50);

			for (const gapMs of [10, 60, 120]) {
				await keys.down(h, key);
				await h.page.waitForTimeout(gapMs);
				await h.page.keyboard.press('c');
				await h.page.waitForTimeout(beatMs + 200);
				await keys.up(h, key);
				await h.page.waitForTimeout(50);
				expect((await readLog(h)).barLog, `${name}+C after ${gapMs} ms shows nothing, however long it stays held`).toEqual([]);
			}

			await keys.down(h, key);
			await h.page.waitForTimeout(beatMs + 100);
			await h.page.keyboard.press('c');
			await h.page.waitForTimeout(beatMs + 100);
			expect(await barIsOn(h), 'another key takes a shown bar away and keeps it away').toBe(false);
			const afterC = await readLog(h);
			expect(afterC.barLog.at(-1)?.on, 'it went').toBe(false);
			expect((afterC.barLog.at(-1)?.at ?? Infinity) - (afterC.pressed.c ?? 0), 'at once').toBeLessThanOrEqual(50);
			await keys.up(h, key);
			await readLog(h);

			await keys.down(h, key);
			await h.page.waitForTimeout(40);
			await h.page.evaluate(() => dispatchEvent(new Event('blur')));
			await h.page.waitForTimeout(beatMs + 200);
			const { x, y } = await centerOf(h, 'p3');
			await h.page.mouse.move(x, y);
			await h.page.waitForTimeout(beatMs + 100);
			await keys.up(h, key);
			await h.page.waitForTimeout(50);
			expect((await readLog(h)).barLog, `${name}+Tab shows nothing, and a pointer moved with the key still down does not bring it back`).toEqual([]);

			await keys.down(h, key, 'Shift');
			await h.page.keyboard.press('g');
			await keys.up(h, 'Shift');
			await h.page.waitForTimeout(beatMs + 150);
			await keys.up(h, key);
			await h.page.waitForTimeout(50);
			expect((await readLog(h)).barLog, `what is left of ${name}+Shift+G shows nothing`).toEqual([]);

			await overId(h, 'p2');
			await keys.down(h, key);
			await h.page.waitForTimeout(beatMs + 100);
			expect(await barIsOn(h)).toBe(true);
			await h.page.mouse.down();
			await h.page.mouse.up();
			await h.page.waitForTimeout(40);
			expect(await barIsOn(h), `${name}+click takes the bar away`).toBe(false);
			await keys.up(h, key);
			await readLog(h);

			const shortcutDelays: number[] = [];
			for (let i = 0; i < 3; i++) {
				await keys.down(h, 'Alt');
				await keys.down(h, 'Shift');
				await h.page.waitForTimeout(120);
				await keys.up(h, 'Shift');
				await keys.up(h, 'Alt');
				await h.page.waitForTimeout(50);
				const { barLog: log, pressed } = await readLog(h);
				shortcutDelays.push(Math.round((log[0]?.at ?? Infinity) - (pressed.Shift ?? 0)));
			}
			console.log(`the shortcut keys to the bar, ms: ${shortcutDelays.join(', ')}`);
			for (const delay of shortcutDelays) expect(delay, 'within a couple of frames').toBeLessThanOrEqual(50);
			expect(errors(h)).toEqual([]);
		});
	}

	test('lane 7: Cmd and a wheel over text folds at once, even inside the wait, over anything else passes, and a page that takes Cmd and the wheel for itself keeps it', async ({ h }) => {
		await setScrollKey(h, 'meta');
		await logWheels(h);
		await overId(h, 'p2');
		await keys.down(h, 'Meta');
		await h.page.mouse.wheel(0, 120);
		await expect.poll(() => levelOf(h, 'p2'), { message: 'inside the wait' }).toBe(1);
		await expectBar(h, 'p2');
		await keys.up(h, 'Meta');
		expect((await takeWheels(h)).every((wheel) => wheel.prevented), 'claimed').toBe(true);
		await h.page.waitForTimeout(latchedMs);

		const { x, y } = await centerOf(h, 'photo');
		await h.page.mouse.move(x, y);
		const scrolled = await h.page.evaluate(() => scrollY);
		await keys.down(h, 'Meta');
		await h.page.mouse.wheel(0, 120);
		await h.page.waitForTimeout(latchedMs);
		await keys.up(h, 'Meta');
		expect((await takeWheels(h)).some((wheel) => wheel.prevented), 'not claimed over a picture').toBe(false);
		await expect.poll(() => h.page.evaluate(() => scrollY), { message: 'the page scrolled as it would' }).toBeGreaterThan(scrolled);
		await h.page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));

		await h.page.evaluate(() => document.getElementById('p3')?.addEventListener('wheel', (event) => event.preventDefault(), { passive: false }));
		await overId(h, 'p3');
		await keys.down(h, 'Meta');
		await h.page.mouse.wheel(0, 120);
		await h.page.waitForTimeout(latchedMs);
		await keys.up(h, 'Meta');
		expect(await levelOf(h, 'p3'), 'a page that handles it first keeps it').toBe(0);

		const leftAlone = async (why: string, before: () => Promise<void>) => {
			await h.page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
			await takeWheels(h);
			await before();
			await h.page.mouse.wheel(0, 120);
			await h.page.waitForTimeout(latchedMs);
			await keys.up(h, 'Meta');
			expect.soft(await levelOf(h, 'p4'), `${why}: nothing folds`).toBe(0);
			expect.soft((await takeWheels(h)).some((wheel) => wheel.prevented), `${why}: the wheel stays with the page`).toBe(false);
		};
		await leftAlone('after Cmd+click', async () => {
			await overId(h, 'p4');
			await keys.down(h, 'Meta');
			await h.page.waitForTimeout(beatMs + 60);
			await h.page.mouse.down();
			await h.page.mouse.up();
		});
		await leftAlone('after Cmd+C', async () => {
			await overId(h, 'p4');
			await keys.down(h, 'Meta');
			await h.page.keyboard.press('c');
		});

		await h.page.evaluate(() => (document.getElementById('field') as HTMLElement).focus({ preventScroll: true }));
		await h.page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
		await overId(h, 'p5');
		await keys.down(h, 'Meta');
		await h.page.mouse.wheel(0, 120);
		await h.page.waitForTimeout(latchedMs);
		expect(await barIsOn(h), 'a focused field has no bar').toBe(false);
		await keys.up(h, 'Meta');
		expect(await levelOf(h, 'p5'), 'and the wheel is about the paragraph under it, so it folds that one').toBe(1);
		await h.page.evaluate(() => (document.activeElement as HTMLElement).blur());
		await takeWheels(h);

		await h.page.evaluate(() => {
			const w = window as unknown as { arrowTaken: boolean | null };
			w.arrowTaken = null;
			addEventListener('keydown', (event) => {
				if (event.key === 'ArrowDown') setTimeout(() => (w.arrowTaken = event.defaultPrevented));
			});
		});
		await overId(h, 'p4');
		await keys.down(h, 'Meta');
		await h.page.waitForTimeout(beatMs + 60);
		await expectBar(h, 'p4');
		await h.page.keyboard.press('ArrowDown');
		await expect.poll(() => h.page.evaluate(() => (window as unknown as { arrowTaken: boolean | null }).arrowTaken), { message: 'Cmd and an arrow stay with the browser' }).toBe(false);
		await keys.up(h, 'Meta');
		expect(await levelOf(h, 'p4')).toBe(0);
		expect(errors(h)).toEqual([]);
	});
});

test.describe('a sweep across paragraphs', () => {
	const unfoldAll = async (h: Harness) => {
		await h.page.mouse.move(2, 2);
		await open(h);
	};

	test('lane 8: moving down extends, moving back shrinks, moving above the anchor selects upward, headings and short paragraphs are skipped, and a jump takes in what is between', async ({ h }) => {
		await tall(h);
		await open(h);
		await overId(h, 'p2');
		await keys.down(h, ...optionShift);
		await expectBar(h, 'p2');
		await overId(h, 'p3');
		await expectBar(h, 'p2', 'p3');
		await overId(h, 'p4');
		await expectBar(h, 'p2', 'p4');
		await overId(h, 'p3');
		await expectBar(h, 'p2', 'p3');
		await overId(h, 'p2');
		await expectBar(h, 'p2');
		await overId(h, 'p1');
		await expectBar(h, 'p1', 'p2');
		await overId(h, 'p4');
		await expectBar(h, 'p2', 'p4');
		await overId(h, 'heading');
		await h.page.waitForTimeout(60);
		await expectBar(h, 'p2', 'p4');
		await overId(h, 'p7');
		await expectBar(h, 'p2', 'p7');
		await h.page.screenshot({ path: await shot('p9-run-light') });
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await levelsOf(h, ps(1, 8)), 'the jump took in everything between, and only that').toEqual([0, 1, 1, 1, 1, 1, 1, 0]);
		const notBlocks = await h.inContent<(number | null)[]>(`['short', 'heading', 'photo'].map((id) => globalThis.__tfold.blockAt(document.getElementById(id))?.level ?? null)`);
		expect(notBlocks, 'what is between and cannot fold was skipped').toEqual([null, null, null]);

		await unfoldAll(h);
		await overId(h, 'p6');
		await keys.down(h, ...optionShift);
		await expectBar(h, 'p6');
		await overId(h, 'p1');
		await expectBar(h, 'p1', 'p6');
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await levelsOf(h, ps(1, 7)), 'a sweep upward folds the same way').toEqual([1, 1, 1, 1, 1, 1, 0]);

		await unfoldAll(h);
		await h.page.evaluate(() => {
			const main = document.querySelector('main') as HTMLElement;
			main.style.display = 'flex';
			main.style.flexDirection = 'column';
			for (const [id, order] of Object.entries({ p3: 1, p1: 2, p4: 3, p2: 4 })) (document.getElementById(id) as HTMLElement).style.order = String(order);
			for (const el of main.children) if (!['p1', 'p2', 'p3', 'p4'].includes(el.id)) (el as HTMLElement).style.order = '9';
		});
		await h.readBlocks();
		await overId(h, 'p3');
		await keys.down(h, ...optionShift);
		await overId(h, 'p1');
		await expectBar(h, 'p3', 'p1');
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await levelsOf(h, ps(1, 4)), 'the order on the page decides what is between, whatever the order in the document').toEqual([1, 0, 1, 0]);
		expect(errors(h)).toEqual([]);
	});

	test('lane 9: a sidebar, another pane and the field between do not join, inside a pane the run stays in the pane, and a feed sweeps across its posts and not its sidebar', async ({ h }) => {
		await tall(h);
		await open(h);
		await overId(h, 'p2');
		await keys.down(h, ...optionShift);
		await expectBar(h, 'p2');
		await overId(h, 'side-2');
		await h.page.waitForTimeout(80);
		await expectBar(h, 'p2');
		await overId(h, 'pane-1');
		await h.page.waitForTimeout(80);
		await expectBar(h, 'p2');
		await overId(h, 'p3');
		await expectBar(h, 'p2', 'p3');
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await levelsOf(h, ['p2', 'p3', 'side-1', 'side-2', 'pane-1'])).toEqual([1, 1, 0, 0, 0]);

		await overId(h, 'side-1');
		await keys.down(h, ...optionShift);
		await overId(h, 'side-2');
		await expectBar(h, 'side-1', 'side-2');
		await overId(h, 'p5');
		await h.page.waitForTimeout(80);
		await expectBar(h, 'side-1', 'side-2');
		await letGo(h, ...optionShift);

		const pane = await shownBox(h.page, 'pane');
		await overId(h, 'pane-1');
		await keys.down(h, ...optionShift);
		await overId(h, 'pane-2');
		await expect.poll(async () => (await barBox(h))?.height ?? 0, { message: 'the run reaches the second paragraph in the pane' }).toBeGreaterThan((await shownBox(h.page, 'pane-1')).height + 10);
		const bar = (await barBox(h)) as Box;
		expect(bar.top, 'starts inside the pane').toBeGreaterThanOrEqual(pane.top);
		expect(bar.bottom, 'stops inside the pane').toBeLessThanOrEqual(pane.bottom);
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await levelsOf(h, ['pane-1', 'pane-2', 'p7', 'p8'])).toEqual([1, 1, 0, 0]);

		await open(h, feed);
		const posts = await h.page.evaluate(() =>
			[...document.querySelectorAll('[data-testid="tweetText"]')]
				.map((el) => ({ box: el.getBoundingClientRect(), el }))
				.filter(({ box }) => box.top > 0 && box.bottom < innerHeight)
				.sort((a, b) => a.box.top - b.box.top)
				.map(({ box }) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2, bottom: box.bottom })),
		);
		expect(posts.length, 'the feed shows several posts').toBeGreaterThanOrEqual(3);
		const [first, , third] = posts as [Point, Point, Point & { bottom: number }];
		await h.page.mouse.move(first.x, first.y);
		await keys.down(h, ...optionShift);
		await h.page.mouse.move(third.x, third.y);
		const barBottom = async () => Math.round((await barBox(h))?.bottom ?? 0);
		await expect.poll(barBottom, { message: 'the line runs across the cells, though each cell clips its own post' }).toBeGreaterThanOrEqual(Math.floor(third.bottom) - 1);
		const threePosts = await barBottom();
		await h.page.mouse.move(1090, third.y);
		await h.page.waitForTimeout(80);
		expect(await barBottom(), 'the sidebar does not join').toBe(threePosts);
		await h.page.mouse.move(third.x, third.y);
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		const levels = (await h.readBlocks()).map((block) => block.level).filter((level) => level !== 0);
		expect(levels, 'three posts at one level').toEqual([1, 1, 1]);
		expect(errors(h)).toEqual([]);
	});

	test('lane 10: the shortcut and the scroll key move a whole run together, unfold it the same way, keep it uniform from the anchor, and the folds stay after letting go', async ({ h }) => {
		await tall(h);
		await open(h);
		await overId(h, 'p3');
		await h.page.keyboard.press('Alt+Shift+ArrowDown');
		await h.page.keyboard.press('Alt+Shift+ArrowDown');
		expect(await levelOf(h, 'p3'), 'a level of its own to begin with').toBe(2);

		await overId(h, 'p2');
		await keys.down(h, ...optionShift);
		await overId(h, 'p4');
		await expectBar(h, 'p2', 'p4');
		await h.page.keyboard.press('ArrowDown');
		expect(await levelsOf(h, ['p2', 'p3', 'p4']), 'the anchor at 0 moves everything to 1').toEqual([1, 1, 1]);
		await h.page.keyboard.press('ArrowDown');
		expect(await levelsOf(h, ['p2', 'p3', 'p4'])).toEqual([2, 2, 2]);
		await h.page.keyboard.press('ArrowUp');
		expect(await levelsOf(h, ['p2', 'p3', 'p4'])).toEqual([1, 1, 1]);
		await letGo(h, ...optionShift);
		expect(await levelsOf(h, ['p2', 'p3', 'p4']), 'the folds stay').toEqual([1, 1, 1]);
		expect(await levelsOf(h, ['p1', 'p5']), 'and nothing else moved').toEqual([0, 0]);

		await keys.down(h, 'Control');
		await overId(h, 'p2');
		await h.page.waitForTimeout(beatMs + 60);
		await overId(h, 'p4');
		await expectBar(h, 'p2', 'p4');
		await h.page.mouse.wheel(0, 120);
		await expect.poll(() => levelsOf(h, ['p2', 'p3', 'p4'])).toEqual([2, 2, 2]);
		await h.page.waitForTimeout(latchedMs);
		await h.page.mouse.wheel(0, 120);
		await expect.poll(() => levelsOf(h, ['p2', 'p3', 'p4']), { message: 'a still pointer keeps the run, whatever the fold moved under it' }).toEqual([3, 3, 3]);
		await h.page.waitForTimeout(latchedMs);
		await h.page.mouse.wheel(0, 120);
		await h.page.waitForTimeout(latchedMs);
		expect(await levelsOf(h, ['p2', 'p3', 'p4']), 'level 3 is as far as it goes').toEqual([3, 3, 3]);
		for (const expected of [2, 1, 0]) {
			await h.page.mouse.wheel(0, -120);
			await expect.poll(() => levelsOf(h, ['p2', 'p3', 'p4'])).toEqual([expected, expected, expected]);
			await h.page.waitForTimeout(latchedMs);
		}
		await letGo(h, 'Control');
		expect(await levelsOf(h, ['p1', 'p5'])).toEqual([0, 0]);

		await open(h);
		await logWheels(h);
		const lastLine = await shownBox(h.page, 'p5');
		await keys.down(h, 'Control');
		await overId(h, 'p4');
		await h.page.waitForTimeout(beatMs + 60);
		await h.page.mouse.move((lastLine.left + lastLine.right) / 2, lastLine.bottom - 3);
		await expectBar(h, 'p4', 'p5');
		await h.page.mouse.wheel(0, 120);
		await expect.poll(() => levelsOf(h, ['p4', 'p5'])).toEqual([1, 1]);
		await h.page.waitForTimeout(latchedMs);
		const under = await h.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x: (lastLine.left + lastLine.right) / 2, y: lastLine.bottom - 3 });
		expect(under, 'the fold pulled the picture up under the pointer').toBe('photo');
		await h.page.mouse.wheel(0, 120);
		await expect.poll(() => levelsOf(h, ['p4', 'p5']), { message: 'a still pointer keeps folding what the line marks, over whatever came to rest under it' }).toEqual([2, 2]);
		expect((await takeWheels(h)).every((wheel) => wheel.prevented), 'neither notch reached the page').toBe(true);
		await h.page.waitForTimeout(latchedMs);
		await keys.up(h, 'Control');

		await open(h);
		await logWheels(h);
		await overId(h, 'p2');
		await keys.down(h, 'Control');
		await h.page.waitForTimeout(beatMs + 60);
		await overId(h, 'p3');
		await expectBar(h, 'p2', 'p3');
		const inside = { x: (await centerOf(h, 'short')).x, y: (await centerOf(h, 'short')).y };
		await h.page.mouse.move(inside.x, inside.y);
		await h.page.waitForTimeout(80);
		await h.page.mouse.wheel(0, 120);
		await expect.poll(() => levelsOf(h, ['p2', 'p3']), { message: 'over a short paragraph inside the line, the wheel folds the run' }).toEqual([1, 1]);
		await h.page.waitForTimeout(latchedMs);
		await keys.up(h, 'Control');

		await open(h);
		await overId(h, 'p2');
		await keys.down(h, 'Control');
		await h.page.mouse.wheel(0, 120);
		await keys.up(h, 'Control');
		await overId(h, 'p4');
		await keys.down(h, 'Control');
		await h.page.mouse.wheel(0, 120);
		await keys.up(h, 'Control');
		await expect.poll(() => levelsOf(h, ['p2', 'p4']), { message: 'let go and moved inside the latch, the next wheel folds what is under it now' }).toEqual([1, 1]);
		expect(errors(h)).toEqual([]);
	});

	test('lane 11: an anchor that cannot go further still brings the run level with it, and with nothing to change the key goes to the page', async ({ h }) => {
		await tall(h);
		await open(h);
		await overId(h, 'p2');
		for (let i = 0; i < 3; i++) await h.page.keyboard.press('Alt+Shift+ArrowDown');
		expect(await levelOf(h, 'p2')).toBe(3);
		await keys.down(h, ...optionShift);
		await overId(h, 'p3');
		await expectBar(h, 'p2', 'p3');
		await h.page.keyboard.press('ArrowDown');
		expect(await levelsOf(h, ['p2', 'p3']), 'the anchor is at the end, and the run comes level').toEqual([3, 3]);
		await h.page.evaluate(() => {
			const w = window as unknown as { keyTaken: boolean | null };
			w.keyTaken = null;
			addEventListener('keydown', (event) => {
				if (event.key === 'ArrowDown') setTimeout(() => (w.keyTaken = event.defaultPrevented));
			});
		});
		await h.page.keyboard.press('ArrowDown');
		await expect.poll(() => h.page.evaluate(() => (window as unknown as { keyTaken: boolean | null }).keyTaken), { message: 'with nothing to change, the key is the page\'s' }).toBe(false);
		await letGo(h, ...optionShift);
		expect(errors(h)).toEqual([]);
	});

	test('lane 12: after a fold the run stays put while the keys are held, even when the pointer moves to another paragraph, and only letting go starts a new one', async ({ h }) => {
		await tall(h);
		await open(h);
		await overId(h, 'p4');
		await keys.down(h, ...optionShift);
		await overId(h, 'p6');
		await expectBar(h, 'p4', 'p6');
		await h.page.keyboard.press('ArrowDown');
		await h.page.waitForTimeout(latchedMs);
		await expectBar(h, 'p4', 'p6');
		await overId(h, 'p7');
		await h.page.waitForTimeout(80);
		await overId(h, 'p1');
		await h.page.waitForTimeout(80);
		await expectBar(h, 'p4', 'p6');
		await h.page.keyboard.press('ArrowDown');
		expect(await levelsOf(h, ps(1, 7)), 'the same run moved again').toEqual([0, 0, 0, 2, 2, 2, 0]);
		await letGo(h, ...optionShift);

		await overId(h, 'p1');
		await keys.down(h, ...optionShift);
		await expectBar(h, 'p1');
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await levelsOf(h, ps(1, 7)), 'a new hold is a new run').toEqual([1, 0, 0, 2, 2, 2, 0]);

		await overId(h, 'p7');
		await h.page.keyboard.press('Alt+Shift+ArrowDown');
		expect(await levelOf(h, 'p7'), 'with the keys let go between folds, the paragraph under the pointer folds alone').toBe(1);

		await open(h);
		await overId(h, 'p4');
		await keys.down(h, ...optionShift);
		await overId(h, 'p6');
		await expectBar(h, 'p4', 'p6');
		await h.page.keyboard.press('ArrowDown');
		await h.page.waitForTimeout(latchedMs);
		await letGo(h, ...optionShift);
		await keys.down(h, ...optionShift);
		await expect.poll(() => barIsOn(h)).toBe(true);
		expect(await barSpans(h, 'p4', 'p4'), 'after a run, the next hold starts at the pointer and not at the last anchor').toBe(false);
		await letGo(h, ...optionShift);

		await open(h);
		await overId(h, 'p4');
		await keys.down(h, ...optionShift);
		await h.page.keyboard.press('ArrowDown');
		await h.page.waitForTimeout(latchedMs);
		await overId(h, 'p1');
		await h.page.keyboard.press('ArrowDown');
		await h.page.waitForTimeout(latchedMs);
		await letGo(h, ...optionShift);
		expect(await levelsOf(h, ['p1', 'p4']), 'held, the fold stayed with the anchor while the pointer went elsewhere').toEqual([0, 2]);
		await keys.down(h, ...optionShift);
		await expectBar(h, 'p1');
		await letGo(h, ...optionShift);

		await open(h);
		await overId(h, 'p2');
		await keys.down(h, ...optionShift);
		await overId(h, 'p3');
		await expectBar(h, 'p2', 'p3');
		await h.page.evaluate(() => document.getElementById('p2')?.remove());
		await h.page.waitForTimeout(600);
		await overId(h, 'p3');
		await expectBar(h, 'p3');
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await levelOf(h, 'p3'), 'an anchor the page took away leaves the paragraph under the pointer').toBe(1);
		expect(errors(h)).toEqual([]);
	});

	test(`lane 13: the run stops at ${maxRun} from the anchor, in either direction, says so, and folds no more than that`, async ({ h }) => {
		await tall(h);
		await open(h);
		await overId(h, 'p1');
		await keys.down(h, ...optionShift);
		const last = `p${maxRun}`;
		await overId(h, last);
		await expectBar(h, 'p1', last);
		expect(await tipOf(h), 'no tip at the cap itself').toBeNull();
		await overId(h, `p${maxRun + 2}`);
		await expect.poll(() => tipOf(h), { message: 'past the cap, it says so' }).toBe(en.runLimit(maxRun));
		await expectBar(h, 'p1', last);
		await h.page.screenshot({ path: await shot('p9-cap') });
		await overId(h, last);
		await expect.poll(() => tipOf(h), { message: 'back inside the cap, the tip goes' }).toBeNull();
		await overId(h, `p${maxRun + 2}`);
		await expect.poll(() => tipOf(h)).toBe(en.runLimit(maxRun));
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await tipOf(h), 'letting go takes the tip away').toBeNull();
		const levels = await levelsOf(h, ps(1, maxRun + 2));
		expect(levels.filter((level) => level === 1), `${maxRun} folded`).toHaveLength(maxRun);
		expect(levels.slice(maxRun), 'nothing past them').toEqual([0, 0]);

		await open(h);
		await overId(h, `p${maxRun + 3}`);
		await keys.down(h, ...optionShift);
		await overId(h, 'p1');
		await expect.poll(() => tipOf(h), { message: 'upward too' }).toBe(en.runLimit(maxRun));
		await expectBar(h, 'p4', `p${maxRun + 3}`);
		await letGo(h, ...optionShift);
		expect(errors(h)).toEqual([]);
	});

	test('lane 14: nothing moves and no bar shifts layout as a run grows, the line is one element, it reads on dark, and with reduced motion a run folds with no ghost', async ({ h }) => {
		await tall(h);
		await open(h);
		await h.page.evaluate(() => {
			const w = window as unknown as { shifted: number };
			w.shifted = 0;
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) w.shifted += (entry as unknown as { value: number }).value;
			}).observe({ type: 'layout-shift', buffered: false });
		});
		const boxes = () => h.page.locator('main p, main h1, main h2').evaluateAll((all) => all.map((el) => { const { left, top, width, height } = el.getBoundingClientRect(); return [left, top, width, height]; }));
		const before = await boxes();
		await overId(h, 'p1');
		await keys.down(h, ...optionShift);
		for (const id of ['p2', 'p3', 'p4', 'p5']) await overId(h, id);
		await expectBar(h, 'p1', 'p5');
		expect(await boxes(), 'nothing moved').toEqual(before);
		const look = await h.page.evaluate(() => {
			const root = document.querySelector('tf-bar')?.shadowRoot;
			return { bars: root?.querySelectorAll('.bar').length, transition: getComputedStyle(root?.querySelector('.bar') as Element).transitionDuration };
		});
		expect(look.bars, 'one line, not ticks').toBe(1);
		await letGo(h, ...optionShift);
		expect(await h.page.evaluate(() => (window as unknown as { shifted: number }).shifted), 'zero layout shift').toBe(0);

		await h.page.evaluate(() => document.body.classList.add('dark'));
		await overId(h, 'p1');
		await keys.down(h, ...optionShift);
		await overId(h, 'p4');
		await expectBar(h, 'p1', 'p4');
		await h.page.waitForTimeout(200);
		await h.page.screenshot({ path: await shot('p9-run-dark') });
		await letGo(h, ...optionShift);
		await h.page.evaluate(() => document.body.classList.remove('dark'));

		await h.page.emulateMedia({ reducedMotion: 'reduce' });
		await overId(h, 'p1');
		await keys.down(h, ...optionShift);
		await overId(h, 'p4');
		await expectBar(h, 'p1', 'p4');
		expect(await h.page.evaluate(() => getComputedStyle(document.querySelector('tf-bar')?.shadowRoot?.querySelector('.bar') as Element).transitionDuration)).toBe('0s');
		await h.page.keyboard.press('ArrowDown');
		expect(await h.page.locator('tfold-ghosts').count(), 'no ghosts').toBe(0);
		await letGo(h, ...optionShift);
		expect(await levelsOf(h, ps(1, 4))).toEqual([1, 1, 1, 1]);
		expect(errors(h)).toEqual([]);
	});

	test('lane 15: keys that go away while the page cannot see them do not stick: a blur, the page going hidden, a let-go seen only on the next pointer move, and a hold seen only on the pointer with no focus', async ({ h }) => {
		test.setTimeout(60_000);
		await open(h);
		await overId(h, 'p2');
		const down = async () => {
			await keys.down(h, ...optionShift);
			await expectBar(h, 'p2');
		};
		await down();
		await h.page.evaluate(() => dispatchEvent(new Event('blur')));
		await expect.poll(() => barIsOn(h), { message: 'a blur takes it away' }).toBe(false);
		await overId(h, 'p2');
		const stillHeld = await centerOf(h, 'p2');
		await h.page.mouse.move(stillHeld.x + 3, stillHeld.y);
		await h.page.waitForTimeout(100);
		expect(await barIsOn(h), 'a key held across the blur does not count again').toBe(false);
		await keys.up(h, ...optionShift);
		await h.page.mouse.move(stillHeld.x + 4, stillHeld.y);

		await down();
		await h.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await expect.poll(() => barIsOn(h), { message: 'hiding the page takes it away' }).toBe(false);
		await keys.up(h, ...optionShift);

		const cdp = await session(h);
		const held = alt | shift;
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stillHeld.x, y: stillHeld.y, modifiers: held });
		await expect.poll(() => barIsOn(h), { message: 'the pointer alone brings it up' }).toBe(true);
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stillHeld.x + 1, y: stillHeld.y });
		await expect.poll(() => barIsOn(h), { message: 'let go outside the page, the next pointer move ends it' }).toBe(false);

		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stillHeld.x + 2, y: stillHeld.y, modifiers: held });
		await expect.poll(() => barIsOn(h)).toBe(true);
		await expect.poll(() => barIsOn(h), { message: 'with no more sightings it ends by itself', timeout: 1000 }).toBe(false);
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stillHeld.x + 3, y: stillHeld.y, modifiers: held });
		await expect.poll(() => barIsOn(h), { message: 'and a key still held shows again on the next move' }).toBe(true);
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stillHeld.x + 4, y: stillHeld.y });
		expect(errors(h)).toEqual([]);
	});

	test('lane 16: a copy from before an update keeps quiet: one bar shows and a run folds once beside it', async ({ headless }) => {
		test.setTimeout(90_000);
		const live = await mkdtemp(path.join(tmpdir(), 'tfold-live-'));
		const build = async (version: string) => {
			await cp(extensionDir, live, { recursive: true });
			const manifest = JSON.parse(await readFile(path.join(live, 'manifest.json'), 'utf8')) as Record<string, unknown>;
			await writeFile(path.join(live, 'manifest.json'), JSON.stringify({ ...manifest, version }));
		};
		await build('0.1.0');
		const h = await launch({ headless }, live);
		try {
			await open(h);
			await overId(h, 'p2');
			await h.page.keyboard.press('Alt+Shift+ArrowDown');
			await build('0.1.1');
			const restarted = h.context.waitForEvent('serviceworker');
			await h.worker.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
			const worker = await restarted;
			await expect.poll(async () => worker.evaluate(() => chrome.runtime.getManifest().version)).toBe('0.1.1');
			await expect.poll(() => h.page.locator('[data-tfold-overlay]').count(), { message: 'the old copy put its fold back', timeout: 10_000 }).toBe(0);
			await h.page.waitForTimeout(500);
			await overId(h, 'p2');
			await keys.down(h, ...optionShift);
			await overId(h, 'p4');
			await expect.poll(() => barCount(h)).toBe(1);
			await h.page.waitForTimeout(100);
			expect(await barCount(h), 'one bar, from the live copy').toBe(1);
			await h.page.keyboard.press('ArrowDown');
			await h.page.waitForTimeout(latchedMs);
			await letGo(h, ...optionShift);
			const shown = await h.page.evaluate(() => ['p2', 'p3', 'p4', 'p5'].map((id) => (document.getElementById(id)?.nextElementSibling?.getAttribute('data-tf-level') ?? null)));
			expect(shown, 'each paragraph folded once, to level 1').toEqual(['1', '1', '1', null]);
			expect(await h.page.locator('[data-tfold-overlay]').count()).toBe(3);
		} finally {
			await h.close();
			await rm(live, { recursive: true, force: true });
		}
	});
});

type Mock = { baseUrl: string; calls: number[]; close(): Promise<void> };

async function mockProvider(takeawayIn = 'A mocked takeaway from the provider.', delayMs = 30, failures = 0, failsWith = 401): Promise<Mock> {
	const calls: number[] = [];
	let toFail = failures;
	const server = http.createServer((request, response) => {
		const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
		if (request.method === 'OPTIONS') {
			response.writeHead(204, cors).end();
			return;
		}
		if (request.method === 'GET') {
			response.writeHead(200, { ...cors, 'content-type': 'application/json' }).end('{"data":{"label":"mock"}}');
			return;
		}
		let raw = '';
		request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		request.on('end', () => {
			const prompt = (JSON.parse(raw) as { messages: { content: string }[] }).messages.at(-1)?.content ?? '';
			const units = [...prompt.matchAll(/^\[U(\d+)\]/gm)].map(([, n]) => ({ id: `U${n}`, takeaway: takeawayIn, reason: 'Why this paragraph says so.', evidence: [0] }));
			calls.push(units.length);
			if (toFail > 0) {
				toFail--;
				response.writeHead(failsWith, { ...cors, 'content-type': 'application/json' }).end('{}');
				return;
			}
			setTimeout(() => {
				response.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(
					JSON.stringify({ id: 'gen-mock', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ units }) } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }),
				);
			}, delayMs);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
		calls,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

test.describe('what a run asks for', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	const settings: [string, Record<string, unknown>, number][] = [['plain', {}, 8], ['translated', { autoTranslate: true, readerLanguage: 'ko' }, 3]];
	for (const [name, sync, window] of settings) {
		test(`lane 17, ${name}: sweeping asks nothing, a fold of 5, 10 and ${maxRun} asks in windows of at most ${window}, with no call per paragraph, and each answer lands in the run`, async ({ headless }) => {
			test.setTimeout(150_000);
			const seen: Record<string, number[]> = {};
			for (const count of [5, 10, maxRun]) {
				const mock = await mockProvider();
				const h = await launch({ headless, allowLiveHosts: ['127.0.0.1'] });
				try {
					await h.worker.evaluate(
						async ({ baseUrl, sync }) => {
							await chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter: { apiKey: 'mock', baseUrl, model: 'mock/model' } }, hintSeen: true });
							await chrome.storage.sync.set(sync);
						},
						{ baseUrl: mock.baseUrl, sync },
					);
					await tall(h);
					await open(h);
					await overId(h, 'p1');
					await keys.down(h, ...optionShift);
					for (let i = 2; i <= count; i++) await overId(h, `p${i}`);
					await expectBar(h, 'p1', `p${count}`);
					await overId(h, 'p2');
					await overId(h, `p${count}`);
					await h.page.waitForTimeout(300);
					expect(mock.calls, 'sweeping alone asks nothing').toEqual([]);
					await h.page.keyboard.press('ArrowDown');
					await letGo(h, ...optionShift);
					await expect
						.poll(() => h.page.evaluate((ids) => ids.every((id) => document.getElementById(id)?.nextElementSibling?.getAttribute('data-tf-fold') === 'model'), ps(1, count)), { message: 'every paragraph got its answer', timeout: 20_000 })
						.toBe(true);
					await h.page.waitForTimeout(300);
					seen[String(count)] = [...mock.calls];
					console.log(`${name} ${count} paragraphs: ${mock.calls.length} calls of ${mock.calls.join(', ')} paragraphs`);
					expect(mock.calls.every((size) => size <= window), 'the window size holds').toBe(true);
					expect(mock.calls.length, 'far fewer calls than paragraphs').toBeLessThanOrEqual(Math.ceil(count / window) + 2);
					expect(errors(h)).toEqual([]);
				} finally {
					await h.close();
					await mock.close();
				}
			}
			console.log(JSON.stringify(seen));
		});
	}
});

test.describe('where the page stays', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	const sampleAnchor = (h: Harness, id: string) =>
		h.page.evaluate((id) => {
			const w = window as unknown as { samples: number[]; stopSampling?: () => void };
			w.samples = [];
			let on = true;
			const read = () => {
				const el = document.getElementById(id) as Element;
				const shown = el.hasAttribute('data-tfold-hidden') ? (el.nextElementSibling as Element) : el;
				return shown.getBoundingClientRect().top;
			};
			const channel = new MessageChannel();
			channel.port1.onmessage = () => w.samples.push(read());
			const tick = () => {
				if (!on) return;
				channel.port2.postMessage(0);
				requestAnimationFrame(tick);
			};
			tick();
			w.stopSampling = () => (on = false);
		}, id);

	const stopSampling = (h: Harness) =>
		h.page.evaluate(() => {
			const w = window as unknown as { samples: number[]; stopSampling: () => void };
			w.stopSampling();
			return w.samples;
		});

	test('lane 18: the anchor stays where it was through the fold of a run above or below it and through the answers that arrive afterward', async ({ headless }) => {
		test.setTimeout(180_000);
		const seen: Record<string, unknown> = {};
		for (const [name, anchor, head, top] of [
			['down, 6', 'p8', 'p13', 900],
			['up, 6', 'p13', 'p8', 900],
			['up, 12', 'p20', 'p9', 1400],
			['up, 12, reduced motion', 'p20', 'p9', 1400],
			['up, 6, no key, where a badge is all that arrives', 'p13', 'p8', 900],
		] as const) {
			const noKey = name.includes('no key');
			const mock = await mockProvider('A takeaway from the provider that runs a little longer than the first sentence does, to move the page.', 400);
			const h = await launch({ headless, allowLiveHosts: ['127.0.0.1'] });
			try {
				if (!noKey) await h.worker.evaluate(({ baseUrl }) => chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter: { apiKey: 'mock', baseUrl, model: 'mock/model' } }, hintSeen: true }), { baseUrl: mock.baseUrl });
				await open(h);
				if (name.endsWith('reduced motion')) await h.page.emulateMedia({ reducedMotion: 'reduce' });
				await h.page.evaluate((top) => scrollTo({ top, behavior: 'instant' }), top);
				await h.page.evaluate((id) => document.getElementById(id)?.scrollIntoView({ block: 'center', behavior: 'instant' }), anchor);
				const scrolledTo = await h.page.evaluate(() => scrollY);
				await overId(h, anchor);
				await keys.down(h, ...optionShift);
				await expectBar(h, anchor);
				const { x } = await centerOf(h, anchor);
				const reachable = await h.page.evaluate((head) => {
					const box = document.getElementById(head)?.getBoundingClientRect();
					return box ? box.top + box.height / 2 : 0;
				}, head);
				if (reachable < 0 || reachable > 700) {
					await h.page.evaluate((head) => {
						const a = document.getElementById(head);
						a?.scrollIntoView({ block: 'center', behavior: 'instant' });
					}, head);
				}
				const headPoint = await centerOf(h, head);
				await h.page.mouse.move(x, headPoint.y);
				await h.page.waitForTimeout(120);
				await h.page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), scrolledTo);
				await h.page.evaluate((id) => document.getElementById(id)?.scrollIntoView({ block: 'center', behavior: 'instant' }), anchor);
				const before = (await shownBox(h.page, anchor)).top;
				await sampleAnchor(h, anchor);
				await h.page.keyboard.press('ArrowDown');
				await h.page.waitForTimeout(600);
				if (noKey) {
					await h.page.keyboard.press('ArrowDown');
					await h.page.waitForTimeout(600);
				}
				const whileFolding = await stopSampling(h);
				await sampleAnchor(h, anchor);
				await letGo(h, ...optionShift);
				expect(await levelsOf(h, [anchor, head]), `${name}, both ends folded`).toEqual(noKey ? [2, 2] : [1, 1]);
				await expect.poll(() => h.page.evaluate((id) => document.getElementById(id)?.nextElementSibling?.getAttribute('data-tf-fold'), anchor), { timeout: 15_000 }).toBe(noKey ? 'local' : 'model');
				await h.page.waitForTimeout(600);
				const whileAnswering = await stopSampling(h);
				const moved = (samples: number[]) => Math.round(Math.max(...samples.map((sample) => Math.abs(sample - before))) * 10) / 10;
				seen[name] = { frames: whileFolding.length, foldedPx: moved(whileFolding), answeredFrames: whileAnswering.length, answeredPx: moved(whileAnswering) };
				expect.soft(moved(whileFolding), `${name}, through the fold`).toBeLessThanOrEqual(2);
				expect.soft(moved(whileAnswering), `${name}, through the answers`).toBeLessThanOrEqual(2);
				expect(errors(h), name).toEqual([]);
			} finally {
				await h.close();
				await mock.close();
			}
		}
		console.log(JSON.stringify(seen));
	});
});

test.describe('the answers that come after', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	const withKey = async (headless: boolean, delayMs: number, scene: (h: Harness, mock: Mock) => Promise<void>, failures = 0, failsWith = 401) => {
		const mock = await mockProvider('A takeaway from the provider that runs a little longer than the first sentence does, to move the page.', delayMs, failures, failsWith);
		const h = await launch({ headless, allowLiveHosts: ['127.0.0.1'] });
		try {
			await h.worker.evaluate(({ baseUrl }) => chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter: { apiKey: 'mock', baseUrl, model: 'mock/model' } }, hintSeen: true }), { baseUrl: mock.baseUrl });
			await open(h);
			await scene(h, mock);
			expect(errors(h)).toEqual([]);
		} finally {
			await h.close();
			await mock.close();
		}
	};
	const answered = (h: Harness, id: string) => expect.poll(() => h.page.evaluate((id) => document.getElementById(id)?.nextElementSibling?.getAttribute('data-tf-fold'), id), { timeout: 15_000 }).toBe('model');

	test('lane 25: an answer that lands after the reader scrolled the anchor partly out of the window leaves the page where the reader put it', async ({ headless }) => {
		await withKey(headless, 800, async (h) => {
			await h.page.evaluate(() => document.getElementById('p8')?.scrollIntoView({ block: 'center', behavior: 'instant' }));
			await overId(h, 'p8');
			await keys.down(h, ...optionShift);
			await overId(h, 'p9');
			await expectBar(h, 'p8', 'p9');
			await h.page.keyboard.press('ArrowDown');
			await letGo(h, ...optionShift);
			await h.page.evaluate(() => scrollBy({ top: (document.getElementById('p8')?.nextElementSibling as Element).getBoundingClientRect().top + 20, behavior: 'instant' }));
			const before = (await shownBox(h.page, 'p8')).top;
			expect(before, 'the top of the anchor is cut off').toBeLessThan(0);
			await answered(h, 'p8');
			await h.page.waitForTimeout(400);
			expect(Math.abs((await shownBox(h.page, 'p8')).top - before), 'the page did not jump').toBeLessThanOrEqual(2);
		});
	});

	test('lane 26: a run that first folds on a later step of a wheel gesture still asks for its answers', async ({ headless }) => {
		await withKey(headless, 30, async (h, mock) => {
			await overId(h, 'p4');
			await keys.down(h, 'Control');
			await h.page.waitForTimeout(beatMs + 60);
			await overId(h, 'p5');
			await expectBar(h, 'p4', 'p5');
			await h.page.mouse.wheel(0, -120);
			await h.page.mouse.wheel(0, 120);
			await expect.poll(() => levelsOf(h, ['p4', 'p5'])).toEqual([1, 1]);
			await h.page.waitForTimeout(latchedMs);
			await keys.up(h, 'Control');
			await answered(h, 'p4');
			await answered(h, 'p5');
			expect(mock.calls.length, 'one call covers the two').toBe(1);
		});
	});

	test('lane 28: a run whose request failed asks again on a later fold, as one paragraph does, and not while it waits', async ({ headless }) => {
		await withKey(
			headless,
			30,
			async (h, mock) => {
				await overId(h, 'p4');
				await keys.down(h, ...optionShift);
				await overId(h, 'p5');
				await expectBar(h, 'p4', 'p5');
				await h.page.keyboard.press('ArrowDown');
				await expect.poll(() => h.page.evaluate(() => document.getElementById('p4')?.nextElementSibling?.getAttribute('data-tf-error')), { message: 'the first request failed', timeout: 10_000 }).not.toBeNull();
				const failed = mock.calls.length;
				await h.page.keyboard.press('ArrowDown');
				await h.page.waitForTimeout(200);
				expect(mock.calls.length, 'the next press is too soon').toBe(failed);
				await h.page.waitForTimeout(failedWaitMs + 100);
				await h.page.keyboard.press('ArrowDown');
				await letGo(h, ...optionShift);
				await answered(h, 'p4');
				await answered(h, 'p5');
				expect(mock.calls.length, 'a later fold asked again').toBeGreaterThan(failed);
			},
			1,
			500,
		);
	});
});

test.describe('where there is nothing left to scroll', () => {
	test('lane 27: at the very top of a page an upward run has no room to hold the anchor, which is the limit the docs state', async ({ h }) => {
		await tall(h);
		await open(h);
		await overId(h, 'p6');
		await keys.down(h, ...optionShift);
		await overId(h, 'p1');
		await expectBar(h, 'p1', 'p6');
		const before = (await shownBox(h.page, 'p6')).top;
		await h.page.keyboard.press('ArrowDown');
		await h.page.waitForTimeout(latchedMs);
		await letGo(h, ...optionShift);
		const moved = before - (await shownBox(h.page, 'p6')).top;
		console.log(`at the top of the page the anchor rose ${Math.round(moved)} px`);
		expect(moved).toBeGreaterThan(2);
		expect(errors(h)).toEqual([]);
	});
});

test.describe('where a pane stays', () => {
	test('lane 24: inside a pane that scrolls, the anchor stays where it was while the run above it folds', async ({ h }) => {
		await tall(h);
		await open(h);
		await h.page.evaluate(() => {
			document.head.insertAdjacentHTML('beforeend', '<style>#pane p { width: 180px }</style>');
			const pane = document.getElementById('pane') as HTMLElement;
			const last = document.getElementById('pane-3') as HTMLElement;
			pane.insertAdjacentHTML('beforeend', '<div style="height:600px"></div>');
			pane.scrollTop += last.getBoundingClientRect().top - pane.getBoundingClientRect().top - 90;
		});
		await h.readBlocks();
		await overId(h, 'pane-3');
		const pane = await shownBox(h.page, 'pane');
		const third = await shownBox(h.page, 'pane-3');
		const inPane = { x: (third.left + third.right) / 2, y: Math.min(third.top + 20, pane.bottom - 4) };
		await h.page.mouse.move(inPane.x, inPane.y);
		await keys.down(h, ...optionShift);
		await h.page.waitForTimeout(60);
		const second = await shownBox(h.page, 'pane-2');
		await h.page.mouse.move(inPane.x, Math.max(second.bottom - 10, pane.top + 4));
		await h.page.waitForTimeout(120);
		const before = (await shownBox(h.page, 'pane-3')).top;
		const scrolled = await h.page.evaluate(() => (document.getElementById('pane') as HTMLElement).scrollTop);
		await h.page.keyboard.press('ArrowDown');
		await h.page.keyboard.press('ArrowDown');
		await h.page.waitForTimeout(500);
		await letGo(h, ...optionShift);
		expect(await levelsOf(h, ['pane-1', 'pane-2', 'pane-3']), 'the two at the bottom of the pane folded').toEqual([0, 2, 2]);
		expect(await h.page.evaluate(() => (document.getElementById('pane') as HTMLElement).scrollTop), 'the pane moved to hold it').toBeLessThan(scrolled);
		const moved = Math.abs((await shownBox(h.page, 'pane-3')).top - before);
		console.log(`the anchor in a pane moved ${moved} px`);
		expect(moved).toBeLessThanOrEqual(2);
		expect(errors(h)).toEqual([]);
	});
});

test.describe('what pointer moves cost', () => {
	type Cost = { taskMs: number; scriptMs: number; layouts: number; styles: number };
	const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

	async function measure(h: Harness, scene: (cdp: CDPSession) => Promise<void>): Promise<Cost> {
		const cdp = await session(h);
		await cdp.send('Performance.enable');
		const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
		const before = await read();
		await scene(cdp);
		const after = await read();
		const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0);
		await cdp.detach();
		return { taskMs: delta('TaskDuration') * 1000, scriptMs: delta('ScriptDuration') * 1000, layouts: delta('LayoutCount'), styles: delta('RecalcStyleCount') };
	}

	test('lane 20: pointer moves while holding the keys stay under a frame each, on a long article and on a feed', async ({ h }) => {
		test.setTimeout(120_000);
		const moves = async (cdp: CDPSession) => {
			for (let i = 0; i < 300; i++) {
				await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 350 + (i % 300), y: 100 + (i % 500), modifiers: alt | shift });
				if (i % 3 === 0) await new Promise((resolve) => setTimeout(resolve, 16));
			}
		};
		for (const [name, url] of Object.entries({ wikipedia: fixtures.wiki, feed })) {
			const costs: Cost[] = [];
			for (let round = 0; round < 5; round++) {
				await h.navigate(url);
				await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
				await h.readBlocks();
				if (name === 'wikipedia') await h.page.evaluate(() => scrollTo({ top: 1500, behavior: 'instant' }));
				await keys.down(h, ...optionShift);
				await h.page.waitForTimeout(100);
				costs.push(await measure(h, moves));
				await keys.up(h, ...optionShift);
			}
			console.log(`${name} holding: ${JSON.stringify(costs)}`);
			expect(median(costs.map((cost) => cost.taskMs)), `${name} holding, under a frame a move`).toBeLessThan(300 * 16);
		}
	});
});

const shot = async (name: string) => {
	await mkdir(outDir, { recursive: true });
	return path.join(outDir, `${name}.png`);
};

test.describe('the motion of a run', () => {
	type Motion = { ghosts: number; frames: number; worstMs: number; over50: number; firstMs: number };

	async function foldAndWatch(h: Harness): Promise<Motion> {
		await h.page.evaluate(() => {
			const w = window as unknown as { frames: number[]; counting: boolean };
			w.frames = [];
			w.counting = true;
			let last = performance.now();
			const tick = (now: number) => {
				w.frames.push(now - last);
				last = now;
				if (w.counting) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		await h.page.keyboard.press('ArrowDown');
		await h.page.waitForTimeout(20);
		const ghosts = await h.page.locator('tfold-w').count();
		await h.page.waitForTimeout(600);
		const frames = await h.page.evaluate(() => {
			const w = window as unknown as { frames: number[]; counting: boolean };
			w.counting = false;
			return w.frames;
		});
		expect(await h.page.locator('tfold-w').count(), 'the morph has ended').toBe(0);
		return { ghosts, frames: frames.length, worstMs: Math.round(Math.max(...frames)), firstMs: Math.round(Math.max(...frames.slice(0, 4))), over50: frames.filter((frame) => frame > 50).length };
	}

	const wikiParagraph = (i: number) => `#mw-content-text section > p:not(.mw-empty-elt):not([data-tfold-overlay]) >> nth=${i}`;

	async function sweepOver(h: Harness, url: string, paragraph: (i: number) => string, count: number, height: number): Promise<void> {
		await h.navigate(url);
		await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
		await h.readBlocks();
		await h.page.setViewportSize({ width: 1280, height });
		const first = await h.pointAt(paragraph(1));
		await keys.down(h, ...optionShift);
		await h.page.mouse.move(first.x + 1, first.y);
		await h.page.waitForTimeout(60);
		if (count === 1) return;
		const last = await h.page.locator(paragraph(count)).first().evaluate((el) => {
			el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
			const { left, top, width, height } = el.getBoundingClientRect();
			return { x: left + width / 2, y: top + height / 2 };
		});
		await h.page.mouse.move(last.x, last.y);
		await h.page.waitForTimeout(150);
		await h.page.locator(paragraph(1)).first().evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
		await h.page.waitForTimeout(100);
	}

	const rounds = async (h: Harness, url: string, paragraph: (i: number) => string, count: number, height: number): Promise<Motion> => {
		const seen: Motion[] = [];
		for (let round = 0; round < 3; round++) {
			await sweepOver(h, url, paragraph, count, height);
			seen.push(await foldAndWatch(h));
			await keys.up(h, ...optionShift);
		}
		const middle = (values: number[]) => [...values].sort((a, b) => a - b)[1] ?? 0;
		return { ghosts: middle(seen.map((one) => one.ghosts)), frames: middle(seen.map((one) => one.frames)), worstMs: middle(seen.map((one) => one.worstMs)), firstMs: middle(seen.map((one) => one.firstMs)), over50: middle(seen.map((one) => one.over50)) };
	};

	test('lane 21: past what shows a run adds no ghost, so the cap costs a first frame and then runs as one paragraph does', async ({ headless }) => {
		test.setTimeout(400_000);
		const seen: Record<string, Motion> = {};
		const h = await launch({ headless });
		try {
			for (const count of [1, 5, 10, maxRun]) {
				seen[`wikipedia ${count}`] = await rounds(h, fixtures.wiki, wikiParagraph, count, 720);
				seen[`article ${count}`] = await rounds(h, sweepPage, (i) => `#p${i}`, count, 720);
			}
			seen[`wikipedia ${maxRun}, a window 1440 tall`] = await rounds(h, fixtures.wiki, wikiParagraph, maxRun, 1440);
		} finally {
			await h.close();
		}
		console.log(JSON.stringify(seen));
		expect(seen[`wikipedia ${maxRun}`]?.ghosts, 'what shows is what moves').toBe(seen['wikipedia 10']?.ghosts);
		for (const [name, motion] of Object.entries(seen)) expect.soft(motion.over50, `${name}, one long frame at the start and no more than two more`).toBeLessThanOrEqual(3);
	});
});

test.describe('the words', () => {
	test('lane 22: settings, the popup and the hint say one thing, in both languages, with Cmd on a Mac and no word about what was removed', async ({ headless }) => {
		test.setTimeout(120_000);
		const seen: Record<string, unknown> = {};
		for (const [lang, table] of [['en', en], ['ko', ko]] as const) {
			const mac = await launch({ headless, lang });
			try {
				await mac.context.addInitScript(`Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })`);
				const settings = await mac.context.newPage();
				await settings.setViewportSize({ width: 860, height: 1100 });
				await settings.goto(`chrome-extension://${mac.extensionId}/options/options.html`);
				await expect(settings.locator('#ways-intro')).toHaveText(table.waysIntro('Cmd', maxRun));
				await settings.locator('#scroll-modifier').scrollIntoViewIfNeeded();
				const macChoices = await settings.locator('#scroll-modifier label').allInnerTexts();
				expect(macChoices.slice(0, 3), 'Cmd first, then the others').toEqual(['Cmd', 'Control', 'Option']);
				expect(await settings.locator('input[name="scroll-modifier"]:checked').getAttribute('value'), 'an untouched setting on a Mac is Cmd').toBe('meta');
				await expect(settings.locator('#scroll-hint'), 'the zoom note shows on a Mac').toBeVisible();
				await settings.locator('#keyboard').screenshot({ path: await shot(`p9-ways-mac-${lang}`) });
				await settings.locator('label:has(input[value="ctrl"])').click();
				await expect.poll(() => mac.worker.evaluate(async () => (await chrome.storage.local.get('scrollModifier')).scrollModifier), { message: 'a choice is stored' }).toBe('ctrl');
				await settings.reload();
				await expect(settings.locator('#ways-intro')).not.toBeEmpty();
				expect(await settings.locator('input[name="scroll-modifier"]:checked').getAttribute('value'), 'a stored choice is kept').toBe('ctrl');
				await settings.close();

				const popup = await mac.context.newPage();
				await popup.goto(`chrome-extension://${mac.extensionId}/popup/popup.html`);
				await expect(popup.locator('#scroll-keys')).not.toBeEmpty();
				seen[`${lang} mac popup, a stored Control`] = await popup.locator('#scroll-keys').textContent();
				await mac.worker.evaluate(() => chrome.storage.local.remove('scrollModifier'));
				await popup.reload();
				await expect(popup.locator('#scroll-keys')).toHaveText(`Cmd+${table.scrollWord} ↓ ↑`);
				await popup.setViewportSize({ width: 320, height: 600 });
				await popup.screenshot({ path: await shot(`p9-popup-mac-${lang}`) });
				const howTo = await popup.locator('#how-title').textContent();
				expect(howTo).toBe(table.popupHow('Cmd'));
				await popup.close();
			} finally {
				await mac.close();
			}

			const h = await launch({ headless, lang });
			try {
				await h.worker.evaluate(() => chrome.storage.local.set({ hintSeen: false }));
				await open(h);
				await overId(h, 'p2');
				await expect.poll(() => h.page.locator('tf-hint').count(), { timeout: 5000 }).toBe(1);
				const hint = await h.page.locator('tf-hint').evaluate((el) => el.shadowRoot?.querySelector('div')?.textContent);
				seen[`${lang} hint`] = hint;
				expect(hint).toContain('Ctrl');
				expect(hint).toContain('Alt+Shift+↓');
				const settings = await h.context.newPage();
				await settings.goto(`chrome-extension://${h.extensionId}/options/options.html`);
				await expect(settings.locator('#ways-intro')).toHaveText(table.waysIntro('Ctrl', maxRun));
				await settings.locator('label:has(input[value="off"])').click();
				await expect(settings.locator('#ways-intro'), 'with scrolling off, it speaks of the shortcut alone').toHaveText(table.waysIntroKeys(maxRun));
				await settings.locator('label:has(input[value="ctrl"])').click();
				const choices = await settings.locator('#scroll-modifier label').allInnerTexts();
				expect(choices.slice(0, 2), 'no Cmd away from a Mac').toEqual(['Ctrl', 'Alt']);
				const words = await settings.evaluate(() => document.body.innerText);
				expect(words).not.toMatch(/pinch|trackpad|spread|오므|벌리|트랙패드/i);
				expect(words, 'the sample hint').toContain(lang === 'en' ? 'hold Ctrl and scroll down' : 'Ctrl 키를 누른 채 아래로 스크롤');
				await settings.close();
			} finally {
				await h.close();
			}
		}
		console.log(JSON.stringify(seen));
	});

	test('lane 23: no string, page or manifest in any edition mentions what was removed', async () => {
		const { readdir } = await import('node:fs/promises');
		for (const dist of Object.values(editionDirs)) {
			for (const file of await readdir(dist, { recursive: true })) {
				if (!/\.(js|html|json)$/.test(file)) continue;
				const text = await readFile(path.join(dist, file), 'utf8');
				expect(text.match(/pinch|trackpad|오므리|벌리면|트랙패드|tf-hud|Copy log/gi), `${dist} ${file}`).toBeNull();
			}
		}
	});
});

test.describe('the clip', () => {
	test('a reader holds the key, sweeps down, scrolls to fold and back, and lets go', async ({ headless }) => {
		test.setTimeout(120_000);
		const videoDir = path.join(outDir, 'video');
		await mkdir(videoDir, { recursive: true });
		const h = await launch({ headless, lang: 'en', recordVideo: { dir: videoDir, size: { width: 1100, height: 720 } } });
		try {
			await h.page.setViewportSize({ width: 1100, height: 720 });
			await h.worker.evaluate(() => chrome.storage.local.set({ hintSeen: true }));
			await open(h);
			const glide = async (id: string, steps = 25) => {
				const { x, y } = await centerOf(h, id);
				await h.page.mouse.move(x, y, { steps });
			};
			await h.page.mouse.move(600, 60);
			await h.page.waitForTimeout(600);
			await glide('p1', 15);
			await h.page.waitForTimeout(400);
			await keys.down(h, 'Control');
			await h.page.waitForTimeout(500);
			await glide('p2');
			await h.page.waitForTimeout(300);
			await glide('p3');
			await h.page.waitForTimeout(300);
			await glide('p4');
			await h.page.waitForTimeout(700);
			await glide('p3');
			await h.page.waitForTimeout(400);
			await glide('p4');
			await h.page.waitForTimeout(500);
			for (const delta of [120, 120]) {
				await h.page.mouse.wheel(0, delta);
				await h.page.waitForTimeout(1200);
			}
			await h.page.mouse.wheel(0, -120);
			await h.page.waitForTimeout(1000);
			await keys.up(h, 'Control');
			await h.page.waitForTimeout(1200);
			const video = h.page.video();
			await h.page.close();
			await video?.saveAs(path.join(outDir, 'p9-sweep.webm'));
		} finally {
			await h.close();
		}
	});
});

const layersPage = '/sweep-layers/nomain.html';
const shapesPage = '/sweep-layers/shapes.html';
const control = 2;

const wheelAt = async (h: Harness, { x, y }: Point, modifiers: number, deltaY = 120) => {
	const cdp = await session(h);
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers });
	await cdp.detach();
};

const sweepAndFold = async (h: Harness, from: string, to: string) => {
	await overId(h, from);
	await keys.down(h, ...optionShift);
	await expectBar(h, from);
	await overId(h, to);
	await h.page.waitForTimeout(120);
	const bar = await barBox(h);
	await h.page.keyboard.press('ArrowDown');
	await h.page.waitForTimeout(120);
	await letGo(h, ...optionShift);
	return bar;
};

const foldedAmong = async (h: Harness, ids: readonly string[]) => {
	const levels = await levelsOf(h, ids);
	return ids.filter((_, i) => levels[i]);
};

test.describe('a run stays in the layer it started in', () => {
	const articleItems = Array.from({ length: 12 }, (_, i) => `b${i + 1}`);
	const inMain = `<!doctype html><html><head><style>body{margin:0;font:16px/1.5 serif}main{width:720px;margin:0 auto}#m{position:fixed;left:50%;top:60px;transform:translateX(-50%);width:640px;background:#fff;border:2px solid #000;padding:16px;z-index:9}li{margin-bottom:10px}</style></head><body><main><p>The article opens with a paragraph long enough to count as one, so that the page has a paragraph inside its main element for this check.</p>${articleItems.map((id, i) => `<ul><li id="${id}">Article list item ${i + 1} says that the harbor office keeps its ledgers on the upper floor and that a reader may ask for them on any weekday morning.</li></ul>`).join('')}</main></body></html>`;
	const modalList = `<ul>${[1, 2, 3].map((i) => `<li id="q${i}">Terms item ${i} says that the deposit for the ferry cannot come back once the crew has confirmed the sailing, whatever the weather does later on.</li>`).join('')}</ul>`;

	test('lane 29: a dialog is a layer however the page places it, so a sweep from it stops at its edge, over what shows below it', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 900 });
		await h.page.route('**/sweep-layers/in-main.html', (route) => route.fulfill({ contentType: 'text/html', body: inMain }));
		await open(h, '/sweep-layers/in-main.html');
		await h.page.evaluate((list) => {
			document.body.insertAdjacentHTML('beforeend', `<div id="m" role="dialog" style="position:absolute;left:320px;top:40px;width:640px;transform:none;background:#fff">${list}</div>`);
		}, modalList);
		await h.page.waitForTimeout(100);
		await h.readBlocks();
		await overId(h, 'q1');
		await keys.down(h, ...optionShift);
		await expectBar(h, 'q1');
		const below = await h.page.evaluate(() => [...document.querySelectorAll('main li')].find((li) => li.getBoundingClientRect().top > (document.getElementById('m') as Element).getBoundingClientRect().bottom)?.id as string);
		await overId(h, below);
		await h.page.waitForTimeout(120);
		await expectBar(h, 'q1');
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await foldedAmong(h, ['q1', 'q2', 'q3', ...articleItems])).toEqual(['q1']);
		expect(errors(h)).toEqual([]);
	});

	for (const [name, html] of [
		['role="dialog"', `<div id="m" role="dialog" aria-modal="true">${modalList}</div>`],
		['a native dialog', `<dialog id="m">${modalList}</dialog>`],
	] as const) {
		test(`lane 29, ${name}: a sweep of a list in a modal over an article folds that list and nothing hidden behind it`, async ({ h }) => {
			await h.page.setViewportSize({ width: 1280, height: 900 });
			await h.page.route('**/sweep-layers/in-main.html', (route) => route.fulfill({ contentType: 'text/html', body: inMain }));
			await open(h, '/sweep-layers/in-main.html');
			await h.page.evaluate((html) => {
				document.body.insertAdjacentHTML('beforeend', html);
				const modal = document.getElementById('m');
				if (modal instanceof HTMLDialogElement) modal.showModal();
			}, html);
			await h.page.waitForTimeout(100);
			await h.readBlocks();
			const [first, last] = [await shownBox(h.page, 'q1'), await shownBox(h.page, 'q3')];
			const bar = await sweepAndFold(h, 'q1', 'q3');
			expect(bar?.top, 'the line starts at the modal list').toBeCloseTo(first.top, -1);
			expect(bar?.bottom, 'and stops at its end').toBeCloseTo(last.bottom, -1);
			expect(await foldedAmong(h, ['q1', 'q2', 'q3', ...articleItems])).toEqual(['q1', 'q2', 'q3']);
			expect(errors(h)).toEqual([]);
		});
	}

	for (const [name, template, prefix] of [['a modal', 'modal-t', 'm'], ['a fixed drawer', 'drawer-t', 'd']] as const) {
		test(`lane 29, ${name} on a page with no main: the sweep stays inside it, and the notice, the cookie bar and the article stay out`, async ({ h }) => {
			await open(h, layersPage);
			await h.page.evaluate((id) => document.body.append((document.getElementById(id) as HTMLTemplateElement).content.cloneNode(true)), template);
			await h.page.waitForTimeout(100);
			await h.readBlocks();
			await sweepAndFold(h, `${prefix}1`, `${prefix}3`);
			expect(await foldedAmong(h, [`${prefix}1`, `${prefix}2`, `${prefix}3`, 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'note', 'cook'])).toEqual([`${prefix}1`, `${prefix}2`, `${prefix}3`]);
			expect(errors(h)).toEqual([]);
		});
	}

	test('lane 29: from the article a sweep over the sticky notice or the fixed cookie bar takes in neither', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 600 });
		await open(h, layersPage);
		await h.page.evaluate(() => scrollTo({ top: 400, behavior: 'instant' }));
		await h.page.waitForTimeout(100);
		const article = await h.page.evaluate(() => [...document.querySelectorAll('#content > p')].map((p) => ({ id: p.id, top: p.getBoundingClientRect().top })));
		const anchor = article.filter(({ top }) => top > 100 && top < 400)[1]?.id as string;
		for (const head of ['cook', 'note']) {
			await overId(h, anchor);
			await keys.down(h, ...optionShift);
			await expectBar(h, anchor);
			await overId(h, head);
			await h.page.waitForTimeout(120);
			await expectBar(h, anchor);
			await letGo(h, ...optionShift);
		}
		await sweepAndFold(h, anchor, 'cook');
		expect(await foldedAmong(h, ['note', 'cook', ...article.map(({ id }) => id)])).toEqual([anchor]);
		expect(errors(h)).toEqual([]);
	});

	test('lane 29: a paragraph that something covers where it sits stays out of a run, whatever the layer, and comes back once uncovered', async ({ h }) => {
		await tall(h);
		await open(h);
		await h.page.evaluate(() => {
			const { left, top, width, height } = (document.getElementById('p3') as HTMLElement).getBoundingClientRect();
			document.body.insertAdjacentHTML('beforeend', `<div id="card" style="position:absolute;left:${left + scrollX}px;top:${top + scrollY}px;width:${width}px;height:${height}px;background:#fff"></div>`);
		});
		await sweepAndFold(h, 'p1', 'p5');
		expect(await foldedAmong(h, ps(1, 6))).toEqual(['p1', 'p2', 'p4', 'p5']);

		await h.page.mouse.move(2, 2);
		await open(h);
		await sweepAndFold(h, 'p1', 'p5');
		expect(await foldedAmong(h, ps(1, 6)), 'with nothing over it the same sweep takes in all five').toEqual(ps(1, 5));
		expect(errors(h)).toEqual([]);
	});

	test('lane 29: a paragraph out of sight is not covered: a run keeps what scrolled off the window or out of its pane', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 700 });
		await open(h);
		await overId(h, 'p2');
		await keys.down(h, ...optionShift);
		await expectBar(h, 'p2');
		await h.page.evaluate(() => {
			const p = document.getElementById('p7') as HTMLElement;
			scrollTo({ top: scrollY + p.getBoundingClientRect().top - 100, behavior: 'instant' });
		});
		await overId(h, 'p7');
		await h.page.waitForTimeout(600);
		expect((await shownBox(h.page, 'p2')).bottom, 'the anchor scrolled off').toBeLessThan(0);
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await foldedAmong(h, ps(1, 8))).toEqual(ps(2, 7));

		await h.page.mouse.move(2, 2);
		await h.page.setViewportSize({ width: 1280, height: 1400 });
		await open(h);
		await h.page.evaluate(() => {
			document.head.insertAdjacentHTML('beforeend', '<style>#pane p { margin-bottom: 300px }</style>');
			document.getElementById('pane')?.scrollIntoView({ block: 'center', behavior: 'instant' });
		});
		await h.readBlocks();
		await overId(h, 'pane-1');
		await keys.down(h, ...optionShift);
		await expectBar(h, 'pane-1');
		await h.page.evaluate(() => {
			const pane = document.getElementById('pane') as HTMLElement;
			pane.scrollTop += (document.getElementById('pane-3') as HTMLElement).getBoundingClientRect().top - pane.getBoundingClientRect().top;
		});
		await overId(h, 'pane-3');
		await h.page.waitForTimeout(600);
		const between = await shownBox(h.page, 'pane-2');
		expect(between.bottom, 'the one between scrolled out of its pane').toBeLessThan((await shownBox(h.page, 'pane')).top);
		expect(between.bottom, 'and not out of the window').toBeGreaterThan(0);
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await foldedAmong(h, ['pane-1', 'pane-2', 'pane-3', 'p7', 'p8'])).toEqual(['pane-1', 'pane-2', 'pane-3']);
		expect(errors(h)).toEqual([]);
	});

	test('lane 33: a paragraph with visibility:hidden is no block and no part of a run, even one that goes hidden after it was found', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 2000 });
		await open(h, shapesPage);
		expect(await levelOf(h, 'hidden-p'), 'not a block').toBeNull();
		await sweepAndFold(h, 's4', 's5');
		expect(await foldedAmong(h, ['s4', 'hidden-p', 's5'])).toEqual(['s4', 's5']);

		await h.page.mouse.move(2, 2);
		await open(h, shapesPage);
		await h.page.evaluate(() => ((document.getElementById('s2') as HTMLElement).style.visibility = 'hidden'));
		await sweepAndFold(h, 's1', 's3');
		const folded = await foldedAmong(h, ['s1', 'l1a', 'l2', 't1', 's3']);
		expect(folded, 'the ends of the run fold').toEqual(expect.arrayContaining(['s1', 's3']));
		expect(await h.page.evaluate(() => document.getElementById('s2')?.nextElementSibling?.hasAttribute('data-tfold-overlay')), 'the one that went hidden does not').toBe(false);

		await h.page.mouse.move(2, 2);
		await h.page.setViewportSize({ width: 1280, height: 700 });
		await open(h);
		await overId(h, 'p2');
		await keys.down(h, ...optionShift);
		await expectBar(h, 'p2');
		await h.page.evaluate(() => {
			(document.getElementById('p3') as HTMLElement).style.visibility = 'hidden';
			const p = document.getElementById('p7') as HTMLElement;
			scrollTo({ top: scrollY + p.getBoundingClientRect().top - 100, behavior: 'instant' });
		});
		await overId(h, 'p7');
		await h.page.waitForTimeout(600);
		expect((await shownBox(h.page, 'p3')).bottom, 'out of sight, where nothing can test what covers it').toBeLessThan(0);
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await h.page.evaluate(() => document.getElementById('p3')?.nextElementSibling?.hasAttribute('data-tfold-overlay')), 'a hidden paragraph out of sight stays out too').toBe(false);
		expect(await foldedAmong(h, ['p2', 'p4', 'p7'])).toEqual(['p2', 'p4', 'p7']);
		expect(errors(h)).toEqual([]);
	});
});

test.describe('a bar raised only from the pointer', () => {
	const held = alt | shift;
	const mouseTo = (cdp: CDPSession, x: number, y: number, modifiers = 0) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });

	test('lane 30: with focus in a frame the bar stays through a slow sweep, ends by itself soon after the last move, and comes back only on another move with the keys', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 2000 });
		await open(h, shapesPage);
		await h.page.frameLocator('#frame').locator('#inner').click();
		expect(await h.page.evaluate(() => document.hasFocus()), 'the top page still says it has focus').toBe(true);
		await barLog(h);
		const { x, y } = await centerOf(h, 's1');
		const cdp = await session(h);
		await keys.down(h, ...optionShift);
		await mouseTo(cdp, x, y, held);
		await expect.poll(() => barIsOn(h), { message: 'the pointer alone brings it up' }).toBe(true);
		for (let i = 1; i <= 15; i++) {
			await mouseTo(cdp, x + i, y, held);
			await h.page.waitForTimeout(200);
			expect(await barIsOn(h), `still on at move ${i}, while the keys are down and the pointer moves`).toBe(true);
		}
		await mouseTo(cdp, x + 20, y, held);
		const lastMove = await h.page.evaluate(() => performance.now());
		await keys.up(h, ...optionShift);
		await expect.poll(() => barIsOn(h), { message: 'gone with no event to say so', timeout: 4000 }).toBe(false);
		const gone = (await readLog(h)).barLog.at(-1)?.at ?? Infinity;
		console.log(`a bar raised from the pointer outlived its last confirming move by ${Math.round(gone - lastMove)} ms`);
		expect(gone - lastMove).toBeLessThanOrEqual(1000);
		await h.page.waitForTimeout(1000);
		expect(await barIsOn(h), 'and stays gone').toBe(false);
		await mouseTo(cdp, x + 21, y, held);
		await expect.poll(() => barIsOn(h), { message: 'a key still held shows it again on the next move' }).toBe(true);
		await mouseTo(cdp, x + 22, y);
		await expect.poll(() => barIsOn(h), { message: 'and a move with none ends it' }).toBe(false);
		expect(errors(h)).toEqual([]);
	});

	test('lane 30: a real key backs a bar that no pointer moves, focus going into a frame ends it, and so does the pointer leaving the window', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 2000 });
		await open(h, shapesPage);
		await overId(h, 's1');
		await keys.down(h, ...optionShift);
		await expectBar(h, 's1');
		await h.page.waitForTimeout(1500);
		expect(await barIsOn(h), 'a key the page saw go down needs no more sightings').toBe(true);
		await h.page.evaluate(() => (document.getElementById('frame') as HTMLIFrameElement).contentWindow?.focus());
		await expect.poll(() => barIsOn(h), { message: 'focus moving into a frame ends it', timeout: 300 }).toBe(false);
		const { x, y } = await centerOf(h, 's1');
		await h.page.mouse.move(x + 3, y);
		await h.page.waitForTimeout(100);
		expect(await barIsOn(h), 'a key held across that does not count again').toBe(false);
		await keys.up(h, ...optionShift);
		await h.page.mouse.move(x + 4, y);
		await h.page.evaluate(() => (document.activeElement as HTMLElement).blur());

		await h.page.frameLocator('#frame').locator('#inner').click();
		const cdp = await session(h);
		await mouseTo(cdp, x, y, held);
		await expect.poll(() => barIsOn(h), { message: 'the pointer alone brings it up' }).toBe(true);
		await h.page.evaluate(() => {
			const w = window as unknown as { left: boolean };
			w.left = false;
			addEventListener('pointerout', (event) => (w.left ||= event.relatedTarget === null), true);
		});
		await mouseTo(cdp, -40, -40, held);
		await expect.poll(() => h.page.evaluate(() => (window as unknown as { left: boolean }).left), { message: 'the pointer left the window' }).toBe(true);
		const leftAt = await h.page.evaluate(() => performance.now());
		await expect.poll(() => barIsOn(h), { message: 'the pointer leaving ends it' }).toBe(false);
		expect((await h.page.evaluate(() => performance.now())) - leftAt, 'without waiting out the time').toBeLessThanOrEqual(300);
		expect(errors(h)).toEqual([]);
	});
});

test.describe('the bar and the input agree', () => {
	type Spot = { id: string; point?: (h: Harness) => Promise<Point>; marks: string | null };
	const gap = (h: Harness) => centerOf(h, 'p2').then(async ({ x }) => ({ x, y: (await shownBox(h.page, 'p1')).bottom + 2 }));
	const photoTop = async (h: Harness) => ({ x: (await centerOf(h, 'photo')).x, y: (await shownBox(h.page, 'photo')).top + 4 });
	const onArticle: Record<'ctrl' | 'meta' | 'alt', Spot[]> = {
		ctrl: [
			{ id: 'p2', marks: 'p2' },
			{ id: 'heading', marks: 'p4' },
			{ id: 'short', marks: 'p2' },
			{ id: 'gap', point: gap, marks: 'p1' },
			{ id: 'photo', point: photoTop, marks: null },
			{ id: 'field', marks: null },
		],
		meta: [
			{ id: 'heading', marks: 'p4' },
			{ id: 'photo', point: photoTop, marks: 'p5' },
			{ id: 'field', marks: null },
		],
		alt: [
			{ id: 'heading', marks: 'p4' },
			{ id: 'photo', point: photoTop, marks: 'p5' },
		],
	};
	const onShapes = ['map', 'in', 'ce', 'frame'];
	const scrollKeys = { ctrl: ['Control', control], meta: ['Meta', 4], alt: ['Alt', alt] } as const;

	for (const key of ['ctrl', 'meta', 'alt'] as const) {
		test(`lane 31, ${key}: where the bar shows the wheel folds what it marks, and where it shows nothing the wheel stays with the page`, async ({ h }) => {
			test.setTimeout(120_000);
			const [name, flag] = scrollKeys[key];
			const scene = async (url: string, { id, point, marks }: Spot) => {
				await setScrollKey(h, key);
				await open(h, url);
				await logWheels(h);
				if (url === shapesPage) await h.page.addStyleTag({ content: '#wide{display:none}' });
				const at = await (point ?? ((at: Harness) => centerOf(at, id)))(h);
				await h.page.mouse.move(at.x, at.y);
				await keys.down(h, name);
				await h.page.waitForTimeout(beatMs + 120);
				if (marks) await expectBar(h, marks);
				else expect(await barIsOn(h), `${key} over ${id} shows nothing`).toBe(false);
				await wheelAt(h, at, flag);
				await h.page.waitForTimeout(latchedMs);
				const claimed = (await takeWheels(h)).some((wheel) => wheel.prevented);
				const folded = (await h.readBlocks()).filter((block) => block.level !== 0).length;
				await keys.up(h, name);
				await h.page.mouse.move(2, 2);
				expect.soft(claimed, `${key} over ${id}: the wheel is claimed only with a bar`).toBe(marks !== null);
				expect.soft(folded, `${key} over ${id}: one paragraph folds only with a bar`).toBe(marks === null ? 0 : 1);
				if (marks) expect.soft(await levelOf(h, marks), `${key} over ${id}: what it marked`).toBe(1);
			};
			await tall(h);
			for (const spot of onArticle[key]) await scene(sweepPage, spot);
			await h.page.setViewportSize({ width: 1280, height: 2000 });
			for (const id of onShapes) await scene(shapesPage, { id, marks: null });
			expect(errors(h)).toEqual([]);
		});
	}

	test('lane 31: from a gap beside a paragraph with no room for a bar, the wheel folds nothing the reader cannot see', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 2000 });
		await setScrollKey(h, 'ctrl');
		await open(h, shapesPage);
		await logWheels(h);
		await h.page.evaluate(() => document.getElementById('wide')?.insertAdjacentHTML('beforebegin', '<h3 id="above-wide" style="margin:0">A title</h3>'));
		const at = await centerOf(h, 'above-wide');
		await h.page.mouse.move(at.x, at.y);
		await keys.down(h, 'Control');
		await h.page.waitForTimeout(beatMs + 150);
		expect(await barIsOn(h), 'no room beside it, above it or below it').toBe(false);
		await wheelAt(h, at, control);
		await h.page.waitForTimeout(latchedMs);
		await keys.up(h, 'Control');
		expect((await takeWheels(h)).some((wheel) => wheel.prevented), 'not claimed').toBe(false);
		expect(await levelOf(h, 'wide-p')).toBe(0);
		expect(errors(h)).toEqual([]);
	});

	test('lane 31: a wheel that comes before the bar stays with the browser over anything but a paragraph, and the keys then stay spent, so Ctrl and a wheel still zooms', async ({ h }) => {
		await tall(h);
		await setScrollKey(h, 'ctrl');
		await logWheels(h);
		const at = await centerOf(h, 'heading');
		await h.page.mouse.move(at.x, at.y);
		await keys.down(h, 'Control');
		await wheelAt(h, at, control);
		await h.page.waitForTimeout(latchedMs);
		expect((await takeWheels(h)).some((wheel) => wheel.prevented), 'not claimed').toBe(false);
		expect(await barIsOn(h), 'and no bar comes up behind it').toBe(false);
		await wheelAt(h, at, control);
		await h.page.waitForTimeout(latchedMs);
		await keys.up(h, 'Control');
		expect((await takeWheels(h)).some((wheel) => wheel.prevented), 'nor on the next turn').toBe(false);
		expect((await h.readBlocks()).filter((block) => block.level !== 0)).toEqual([]);
		expect(errors(h)).toEqual([]);
	});

	test('lane 31: during a sweep the bar goes over a canvas and the wheel with it, comes back past it, and over a heading the wheel folds the run it marks', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 2000 });
		await setScrollKey(h, 'ctrl');
		await open(h, shapesPage);
		await h.page.addStyleTag({ content: 'html{overflow:hidden}' });
		await logWheels(h);
		await overId(h, 's6');
		await keys.down(h, 'Control');
		await h.page.waitForTimeout(beatMs + 60);
		await expectBar(h, 's6');
		await overId(h, 's7');
		await expectBar(h, 's6', 's7');
		const canvas = await centerOf(h, 'map');
		await h.page.mouse.move(canvas.x, canvas.y);
		await expect.poll(() => barIsOn(h), { message: 'no bar over the canvas' }).toBe(false);
		await wheelAt(h, canvas, control);
		await h.page.waitForTimeout(latchedMs);
		expect((await takeWheels(h)).some((wheel) => wheel.prevented), 'the canvas keeps the wheel').toBe(false);
		expect(await levelsOf(h, ['s6', 's7'])).toEqual([0, 0]);
		await wheelAt(h, canvas, control);
		await overId(h, 's7');
		const past = await centerOf(h, 's7');
		for (let turn = 0; turn < 4; turn++) {
			await wheelAt(h, past, control);
			await h.page.waitForTimeout(80);
		}
		expect(await barIsOn(h), 'a wheel gesture goes on as it began, so while the wheel is still the page\'s no bar shows').toBe(false);
		expect(await levelsOf(h, ['s6', 's7']), 'and those turns fold nothing').toEqual([0, 0]);
		await expectBar(h, 's6', 's7');
		await keys.up(h, 'Control');

		await tall(h);
		await open(h);
		await logWheels(h);
		await overId(h, 'p2');
		await keys.down(h, 'Control');
		await h.page.waitForTimeout(beatMs + 60);
		await overId(h, 'p3');
		await expectBar(h, 'p2', 'p3');
		const heading = await centerOf(h, 'heading');
		await h.page.mouse.move(heading.x, heading.y);
		await h.page.waitForTimeout(100);
		await expectBar(h, 'p2', 'p3');
		await wheelAt(h, heading, control);
		await expect.poll(() => levelsOf(h, ['p1', 'p2', 'p3', 'p4'])).toEqual([0, 1, 1, 0]);
		expect((await takeWheels(h)).some((wheel) => !wheel.prevented), 'claimed').toBe(false);
		await keys.up(h, 'Control');
		expect(errors(h)).toEqual([]);
	});

	for (const [name, method] of [
		['cancels it', 'preventDefault'],
		['keeps it from going further', 'stopPropagation'],
	] as const) {
		test(`lane 31: a page that ${name} shows it handles the wheel, so the bar goes at the first turn until the keys are let go`, async ({ h }) => {
			await setScrollKey(h, 'ctrl');
			await h.page.evaluate((method) => {
				document.getElementById('p3')?.addEventListener('wheel', (event) => event[method](), { passive: false });
			}, method);
			await overId(h, 'p3');
			await keys.down(h, 'Control');
			await h.page.waitForTimeout(beatMs + 60);
			await expectBar(h, 'p3');
			await wheelAt(h, await centerOf(h, 'p3'), control);
			await expect.poll(() => barIsOn(h), { message: 'the page has said so' }).toBe(false);
			await h.page.waitForTimeout(latchedMs);
			expect(await barIsOn(h), 'and it stays away').toBe(false);
			await keys.up(h, 'Control');
			expect(await levelOf(h, 'p3')).toBe(0);
			expect(errors(h)).toEqual([]);
		});
	}

	test('lane 31: the arrow folds what the bar marks, from a heading, a picture and a canvas, where the wheel of the scroll key has no say', async ({ h }) => {
		for (const [from, marks] of [['heading', 'p4'], ['photo', 'p5']] as const) {
			await tall(h);
			await open(h);
			const at = from === 'photo' ? await photoTop(h) : await centerOf(h, from);
			await h.page.mouse.move(at.x, at.y);
			await keys.down(h, ...optionShift);
			await expectBar(h, marks);
			await h.page.keyboard.press('ArrowDown');
			await letGo(h, ...optionShift);
			expect((await h.readBlocks()).filter((block) => block.level !== 0)).toHaveLength(1);
			expect(await levelOf(h, marks)).toBe(1);
			await h.page.mouse.move(2, 2);
		}
		await h.page.setViewportSize({ width: 1280, height: 2000 });
		await open(h, shapesPage);
		await overId(h, 'map');
		await keys.down(h, ...optionShift);
		await expect.poll(() => barIsOn(h)).toBe(true);
		const marked = (await barSpans(h, 's6', 's6')) ? 's6' : 's7';
		await expectBar(h, marked);
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await foldedAmong(h, ['s6', 's7'])).toEqual([marked]);
		expect(errors(h)).toEqual([]);
	});
});

test.describe('a provider that keeps saying no', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });
	const errorOf = (h: Harness, id: string) => h.page.evaluate((id) => document.getElementById(id)?.nextElementSibling?.getAttribute('data-tf-error') ?? null, id);
	const withMock = async (headless: boolean, mock: Mock, scene: (h: Harness) => Promise<void>) => {
		const h = await launch({ headless, allowLiveHosts: ['127.0.0.1'] });
		try {
			await h.worker.evaluate(({ baseUrl }) => chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter: { apiKey: 'mock', baseUrl, model: 'mock/model' } }, hintSeen: true }), { baseUrl: mock.baseUrl });
			await tall(h);
			await open(h);
			await scene(h);
		} finally {
			await h.close();
			await mock.close();
		}
	};
	const pressOnOneParagraph = async (h: Harness, times: number) => {
		await overId(h, 'p1');
		for (let i = 0; i < times; i++) {
			await h.page.keyboard.press('Alt+Shift+ArrowDown');
			await h.page.waitForTimeout(33);
		}
	};

	test('lane 32: against a refused key, 30 arrow presses make one call for a paragraph and one per window for a run of 20, then no more until the settings change, and the badge stays', async ({ headless }) => {
		test.setTimeout(120_000);
		const refusing = () => mockProvider(undefined, 30, Infinity);
		const one = await refusing();
		await withMock(headless, one, async (h) => {
			await pressOnOneParagraph(h, 30);
			await h.page.waitForTimeout(800);
			console.log(`one paragraph, 30 presses, refused: ${one.calls.length} calls`);
			expect(one.calls.length).toBe(1);
			expect(await errorOf(h, 'p1'), 'the badge says why').toBe('refused');
		});

		const run = await refusing();
		await withMock(headless, run, async (h) => {
			await overId(h, 'p1');
			await keys.down(h, ...optionShift);
			await overId(h, 'p20');
			await expectBar(h, 'p1', 'p20');
			for (let i = 0; i < 30; i++) {
				await h.page.keyboard.press('ArrowDown');
				await h.page.waitForTimeout(33);
			}
			await h.page.waitForTimeout(800);
			console.log(`a run of 20, 30 presses, refused: ${run.calls.length} calls`);
			expect(run.calls.length, 'one for each window of eight in each of its two sections').toBeLessThanOrEqual(4);
			expect(await errorOf(h, 'p1')).toBe('refused');
			expect(await errorOf(h, 'p20')).toBe('refused');

			const asked = run.calls.length;
			await h.page.waitForTimeout(failedWaitMs + 500);
			await h.page.keyboard.press('ArrowDown');
			await letGo(h, ...optionShift);
			await h.page.mouse.move(2, 2);
			await open(h);
			await pressOnOneParagraph(h, 2);
			await h.page.waitForTimeout(500);
			expect(run.calls.length, 'the same key asks nothing more, after the wait, or from a page opened again').toBe(asked);
			expect(await errorOf(h, 'p1'), 'and the badge is as honest there').toBe('refused');

			await h.worker.evaluate(({ baseUrl }) => chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter: { apiKey: 'another', baseUrl, model: 'mock/model' } } }), { baseUrl: run.baseUrl });
			await h.page.waitForTimeout(failedWaitMs + 100);
			await h.page.keyboard.press('Alt+Shift+ArrowUp');
			await h.page.keyboard.press('Alt+Shift+ArrowDown');
			await expect.poll(() => run.calls.length, { message: 'another key asks again' }).toBeGreaterThan(asked);
		});
	});

	test('lane 32: a key check in settings that passes lets the same key ask again, with no other change', async ({ headless }) => {
		const mock = await mockProvider(undefined, 30, 1);
		await withMock(headless, mock, async (h) => {
			await pressOnOneParagraph(h, 1);
			await expect.poll(() => errorOf(h, 'p1')).toBe('refused');
			const settings = await h.context.newPage();
			await settings.goto(`chrome-extension://${h.extensionId}/options/options.html`);
			const verdict: unknown = await settings.evaluate(() => chrome.runtime.sendMessage({ type: 'check-key', provider: 'openrouter', apiKey: 'mock' }));
			expect(verdict).toBe('works');
			await settings.close();
			await h.page.bringToFront();
			await h.page.waitForTimeout(failedWaitMs + 100);
			await h.page.keyboard.press('Alt+Shift+ArrowUp');
			await h.page.keyboard.press('Alt+Shift+ArrowDown');
			await expect.poll(() => h.page.evaluate(() => document.getElementById('p1')?.nextElementSibling?.getAttribute('data-tf-fold')), { message: 'it got its answer', timeout: 10_000 }).toBe('model');
		});
	});

	test('lane 32: a fold nearby does not bring along paragraphs that are still waiting', async ({ headless }) => {
		const mock = await mockProvider(undefined, 30, 1, 500);
		await withMock(headless, mock, async (h) => {
			await overId(h, 'p23');
			await h.page.keyboard.press('Alt+Shift+ArrowDown');
			await expect.poll(() => errorOf(h, 'p23'), { message: 'the window around the last paragraph failed, which reaches back to p18' }).not.toBeNull();
			await overId(h, 'p16');
			await h.page.keyboard.press('Alt+Shift+ArrowDown');
			await expect.poll(() => h.page.evaluate(() => document.getElementById('p16')?.nextElementSibling?.getAttribute('data-tf-fold')), { message: 'the nearby fold got its answer', timeout: 10_000 }).toBe('model');
			await overId(h, 'p18');
			await h.page.keyboard.press('Alt+Shift+ArrowDown');
			await h.page.waitForTimeout(200);
			expect(await h.page.evaluate(() => document.getElementById('p18')?.nextElementSibling?.getAttribute('data-tf-fold')), 'p18 was not asked for again while it waits').toBe('local');
			expect(mock.calls.length).toBe(2);
		});
	});

	for (const status of [500, 429]) {
		test(`lane 32, ${status}: a failed paragraph waits, 30 presses make one call, and a later gesture asks again and gets its answer`, async ({ headless }) => {
			test.setTimeout(60_000);
			const mock = await mockProvider(undefined, 30, 1, status);
			await withMock(headless, mock, async (h) => {
				await pressOnOneParagraph(h, 30);
				await h.page.waitForTimeout(100);
				expect(mock.calls.length, 'one attempt while it waits').toBe(1);
				expect(await errorOf(h, 'p1')).not.toBeNull();
				await h.page.waitForTimeout(failedWaitMs + 100);
				await h.page.keyboard.press('Alt+Shift+ArrowUp');
				await h.page.keyboard.press('Alt+Shift+ArrowDown');
				await expect.poll(() => h.page.evaluate(() => document.getElementById('p1')?.nextElementSibling?.getAttribute('data-tf-fold')), { message: 'the later gesture got its answer', timeout: 10_000 }).toBe('model');
				expect(mock.calls.length, 'with one more call').toBe(2);
				expect(await errorOf(h, 'p1'), 'the badge is gone').toBeNull();
			});
		});
	}
});

test.describe('a page that renders again under a hold', () => {
	test('lane 34: a run survives elements replaced under it, by what each paragraph says, and a removed paragraph or anchor ends cleanly on what remains', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 1400 });
		await open(h);
		await overId(h, 'p1');
		await keys.down(h, ...optionShift);
		await expectBar(h, 'p1');
		await overId(h, 'p4');
		await expectBar(h, 'p1', 'p4');
		const height = (await barBox(h))?.height ?? 0;
		await h.page.evaluate(() => {
			const w = window as unknown as { rendering: number };
			w.rendering = window.setInterval(() => {
				for (const id of ['p1', 'p2', 'p3', 'p4']) {
					const el = document.getElementById(id) as Element;
					el.replaceWith(el.cloneNode(true));
				}
			}, 200);
		});
		const seen: number[] = [];
		for (let i = 0; i < 12; i++) {
			await h.page.waitForTimeout(100);
			seen.push(Math.round((await barBox(h))?.height ?? 0));
		}
		console.log(`the bar through re-renders, px: ${seen.join(', ')}`);
		for (const each of seen) expect(each, 'the whole run stays marked').toBeGreaterThanOrEqual(height - 1);
		await h.page.keyboard.press('ArrowDown');
		await h.page.waitForTimeout(300);
		expect(await levelsOf(h, ps(1, 5)), 'the whole run folds').toEqual([1, 1, 1, 1, 0]);
		await letGo(h, ...optionShift);
		await h.page.evaluate(() => clearInterval((window as unknown as { rendering: number }).rendering));
		await h.page.waitForTimeout(400);
		expect(await levelsOf(h, ps(1, 5)), 'and stays folded').toEqual([1, 1, 1, 1, 0]);
		expect(await h.page.locator('[data-tfold-overlay]').count(), 'one fold each').toBe(4);
		expect(errors(h)).toEqual([]);

		await h.page.mouse.move(2, 2);
		await open(h);
		await overId(h, 'p1');
		await keys.down(h, ...optionShift);
		await overId(h, 'p4');
		await expectBar(h, 'p1', 'p4');
		await h.page.evaluate(() => document.getElementById('p3')?.remove());
		await expectBar(h, 'p1', 'p4');
		await h.page.evaluate(() => document.getElementById('p1')?.remove());
		const { x, y } = await centerOf(h, 'p4');
		await h.page.mouse.move(x, y);
		await expectBar(h, 'p4');
		await h.page.keyboard.press('ArrowDown');
		await letGo(h, ...optionShift);
		expect(await foldedAmong(h, ['p2', 'p4', 'p5'])).toEqual(['p4']);
		expect(errors(h)).toEqual([]);
	});
});

test.describe('where the page ends', () => {
	test('lane 35: at the very bottom of a page a shorter run pulls the anchor down with it, which is the limit the docs state', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 800 });
		await open(h, layersPage);
		await h.page.addStyleTag({ content: '#cookie,#notice{display:none}#content{padding-bottom:0!important}' });
		await h.page.evaluate(() => {
			for (const p of document.querySelectorAll('#content > p')) p.append(' A second sentence adds what the survey made of that a year later. A third one says what the town then did about it.');
			scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
		});
		await h.readBlocks();
		await h.page.waitForTimeout(150);
		const shown = await h.page.evaluate(() => [...document.querySelectorAll('#content > p')].filter((p) => p.getBoundingClientRect().top > 0).map((p) => p.id));
		const [anchor, last] = [shown[0] as string, shown.at(-1) as string];
		await overId(h, anchor);
		await keys.down(h, ...optionShift);
		await overId(h, last);
		await expectBar(h, anchor, last);
		const before = (await shownBox(h.page, anchor)).top;
		for (let i = 0; i < 3; i++) await h.page.keyboard.press('ArrowDown');
		await h.page.waitForTimeout(latchedMs);
		await letGo(h, ...optionShift);
		const moved = (await shownBox(h.page, anchor)).top - before;
		console.log(`at the bottom of the page the anchor moved ${Math.round(moved)} px`);
		expect(moved).toBeGreaterThan(2);
		expect(errors(h)).toEqual([]);
	});
});

test.describe('a run has no holes', () => {
	const between = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `a${from + i}`);
	const everyParagraph = between(1, 15);
	const pinBar = (style: string) => `<div id="pin" style="${style};background:#ddd"></div>`;
	const asPane = '#content{box-sizing:border-box;height:560px;overflow:auto;padding-top:0}';

	type Landing = { id: string; edge: 'top' | 'bottom'; at: number };
	type Scene = { name: string; into: string; pin: string; inShadow?: boolean; css?: string; pane?: boolean; before?: Landing; anchor: number; head: number; landing: Landing; under: string[]; thenScroll?: boolean };

	const land = (h: Harness, { id, edge, at }: Landing, pane = false) =>
		h.page.evaluate(
			({ id, edge, at, pane }) => {
				const top = (document.getElementById(id) as Element).getBoundingClientRect()[edge] - at;
				(pane ? (document.getElementById('content') as Element) : window).scrollBy({ top, behavior: 'instant' });
			},
			{ id, edge, at, pane },
		);

	const sticky64 = pinBar('position:sticky;top:0;height:64px');
	const scenes: Scene[] = [
		{ name: 'a sticky header 64 px tall', into: 'body', pin: sticky64, anchor: 3, head: 7, landing: { id: 'a4', edge: 'bottom', at: 62 }, under: ['a4'] },
		{ name: 'a fixed header 120 px tall', into: 'body', pin: pinBar('position:fixed;top:0;left:0;right:0;height:120px'), anchor: 3, head: 8, landing: { id: 'a5', edge: 'bottom', at: 118 }, under: ['a4', 'a5'] },
		{ name: 'a fixed banner at the bottom on an upward run', into: 'body', pin: pinBar('position:fixed;bottom:0;left:0;right:0;height:150px'), before: { id: 'a9', edge: 'top', at: 300 }, anchor: 9, head: 4, landing: { id: 'a7', edge: 'top', at: 452 }, under: ['a7', 'a8'] },
		{ name: 'a sticky header over the end of a run the pointer has left', into: 'body', pin: sticky64, anchor: 3, head: 7, landing: { id: 'a7', edge: 'bottom', at: 62 }, under: ['a7'], thenScroll: true },
		{ name: 'a sticky header in a pane', into: 'content', pin: sticky64, css: asPane, pane: true, anchor: 3, head: 7, landing: { id: 'a4', edge: 'bottom', at: 62 }, under: ['a4'] },
		{ name: 'a toolbar laid over a pane from outside it', into: 'body', pin: pinBar('position:absolute;top:0;left:0;right:0;height:64px;z-index:5'), css: asPane, pane: true, anchor: 3, head: 7, landing: { id: 'a4', edge: 'bottom', at: 62 }, under: ['a4'] },
		{ name: 'a header fixed inside a custom element', into: 'body', pin: pinBar('position:fixed;top:0;left:0;right:0;height:64px'), inShadow: true, anchor: 3, head: 7, landing: { id: 'a4', edge: 'bottom', at: 62 }, under: ['a4'] },
	];

	for (const { name, into, pin, inShadow = false, css = '', pane = false, before, anchor, head, landing, under, thenScroll = false } of scenes) {
		test(`lane 36, ${name}: a paragraph that scrolled under it stays in the run, so what the line spans is what folds`, async ({ h }) => {
			await h.page.setViewportSize({ width: 1280, height: 600 });
			await open(h, layersPage);
			await h.page.addStyleTag({ content: `#cookie,#notice{display:none}${css}` });
			await h.page.evaluate(
				({ into, pin, inShadow }) => {
					const holder = into === 'body' ? document.body : (document.getElementById(into) as Element);
					if (!inShadow) return holder.insertAdjacentHTML('afterbegin', pin);
					const host = document.createElement('site-head');
					host.attachShadow({ mode: 'open' }).innerHTML = pin;
					holder.prepend(host);
				},
				{ into, pin, inShadow },
			);
			await h.readBlocks();
			if (before) await land(h, before, pane);
			const [start, end] = [`a${anchor}`, `a${head}`];
			await overId(h, start);
			await keys.down(h, ...optionShift);
			await expectBar(h, start);
			if (thenScroll) await overId(h, end);
			await land(h, landing, pane);
			if (!thenScroll) await overId(h, end);
			const pinned = await h.page.evaluate(() => ((document.getElementById('pin') ?? document.querySelector('site-head')?.shadowRoot?.getElementById('pin')) as Element).getBoundingClientRect().toJSON() as DOMRect);
			for (const id of under) {
				const { top, bottom } = await shownBox(h.page, id);
				expect(Math.max(top, 0), `all that shows of ${id} is under the bar`).toBeGreaterThanOrEqual(pinned.top);
				expect(Math.min(bottom, 600), `all that shows of ${id} is under the bar`).toBeLessThanOrEqual(pinned.bottom);
			}
			await h.page.waitForTimeout(600);
			const [from, to] = anchor < head ? [anchor, head] : [head, anchor];
			await expectBar(h, `a${from}`, `a${to}`);
			await h.page.keyboard.press('ArrowDown');
			await h.page.waitForTimeout(120);
			await letGo(h, ...optionShift);
			expect(await foldedAmong(h, everyParagraph), 'the whole span folds').toEqual(between(from, to));
			expect(errors(h)).toEqual([]);
		});
	}

	test('lane 36: what moves with a paragraph still covers it, and a dialog still keeps what it hides out of a run', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 600 });
		await open(h, layersPage);
		await h.page.addStyleTag({ content: `#cookie,#notice{display:none}${asPane}#content{position:relative}` });
		await h.page.evaluate(() => {
			const { offsetTop, offsetLeft, offsetWidth, offsetHeight } = document.getElementById('a5') as HTMLElement;
			(document.getElementById('content') as Element).insertAdjacentHTML('beforeend', `<div style="position:absolute;top:${offsetTop}px;left:${offsetLeft}px;width:${offsetWidth}px;height:${offsetHeight}px;background:#fff"></div>`);
		});
		await h.readBlocks();
		await sweepAndFold(h, 'a3', 'a7');
		expect(await foldedAmong(h, everyParagraph), 'a card in the pane').toEqual(['a3', 'a4', 'a6', 'a7']);

		await h.page.mouse.move(2, 2);
		await open(h, layersPage);
		await h.page.addStyleTag({ content: '#cookie,#notice{display:none}' });
		await h.page.evaluate(() => {
			const { top, height } = (document.getElementById('a4') as Element).getBoundingClientRect();
			document.body.insertAdjacentHTML('beforeend', `<div role="dialog" style="position:fixed;top:${top}px;left:0;right:0;height:${height}px;background:#fff"></div>`);
		});
		await h.readBlocks();
		await sweepAndFold(h, 'a2', 'a6');
		expect(await foldedAmong(h, everyParagraph), 'a dialog over the page').toEqual(['a2', 'a3', 'a5', 'a6']);
		expect(errors(h)).toEqual([]);
	});
});

test.describe('with no line nothing folds', () => {
	const logArrows = (h: Harness) =>
		h.page.evaluate(() => {
			const w = window as unknown as { arrows: { prevented: boolean }[] };
			w.arrows = [];
			addEventListener('keydown', (event) => {
				if (!event.key.startsWith('Arrow')) return;
				const arrow = { prevented: false };
				w.arrows.push(arrow);
				setTimeout(() => (arrow.prevented = event.defaultPrevented));
			});
		});

	const pressGoesToPage = async (h: Harness, marked: readonly string[]) => {
		await h.page.waitForTimeout(latchedMs);
		const scrolled = await h.page.evaluate(() => scrollY);
		for (const key of ['ArrowDown', 'ArrowUp']) {
			await h.page.keyboard.press(key);
			await h.page.waitForTimeout(150);
			expect(await foldedAmong(h, marked), `${key} folds nothing`).toEqual([]);
			expect(await h.page.evaluate(() => scrollY), `${key} leaves the view where it was`).toBe(scrolled);
		}
		const arrows = await h.page.evaluate(() => (window as unknown as { arrows: { prevented: boolean }[] }).arrows.splice(0));
		expect(arrows.map((arrow) => arrow.prevented), 'the page gets both presses to itself').toEqual([false, false]);
	};

	const pastTheEnd = (h: Harness, id: string) =>
		h.page.evaluate((id) => {
			const { bottom } = (document.getElementById(id) as Element).getBoundingClientRect();
			scrollBy({ top: bottom + 2, behavior: 'instant' });
		}, id);

	test(`lane 37: a run stopped at ${maxRun} that scrolled out of sight shows no line, the arrow stays with the page, and with the run back in sight it folds`, async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 700 });
		await open(h);
		await logArrows(h);
		await overId(h, 'p1');
		await keys.down(h, ...optionShift);
		await expectBar(h, 'p1');
		const last = `p${maxRun}`;
		await pastTheEnd(h, last);
		await overId(h, `p${maxRun + 2}`);
		await expect.poll(() => barIsOn(h), { message: 'nothing of the run shows' }).toBe(false);
		expect(await tipOf(h), 'and no tip speaks for it').toBeNull();
		const run = ps(1, maxRun);
		await pressGoesToPage(h, run);

		await h.page.evaluate((id) => (document.getElementById(id) as Element).scrollIntoView({ block: 'center', behavior: 'instant' }), last);
		await expect.poll(() => barIsOn(h), { message: 'back in sight the line returns' }).toBe(true);
		await h.page.keyboard.press('ArrowDown');
		await h.page.waitForTimeout(120);
		await letGo(h, ...optionShift);
		expect(await foldedAmong(h, ps(1, maxRun + 2)), 'what it marks folds').toEqual(run);
		expect(errors(h)).toEqual([]);
	});

	test('lane 37: one paragraph or a short run that scrolled out of sight shows no line, and the arrow stays with the page', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 700 });
		for (const head of ['p2', 'p3']) {
			await h.page.mouse.move(2, 2);
			await open(h);
			await logArrows(h);
			await overId(h, 'p2');
			await keys.down(h, ...optionShift);
			await overId(h, head);
			await expectBar(h, 'p2', head);
			await pastTheEnd(h, 'p3');
			await overId(h, 'heading');
			await expect.poll(() => barIsOn(h), { message: 'over a heading with the run out of sight' }).toBe(false);
			await pressGoesToPage(h, ['p2', 'p3', 'p4']);
			await letGo(h, ...optionShift);
		}
		expect(errors(h)).toEqual([]);
	});

	test('lane 37: the wheel agrees: with the run out of sight it stays with the page, even over a paragraph past the cap', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 700 });
		await setScrollKey(h, 'ctrl');
		await logWheels(h);
		await overId(h, 'p1');
		await keys.down(h, 'Control');
		await h.page.waitForTimeout(beatMs + 60);
		await expectBar(h, 'p1');
		await pastTheEnd(h, `p${maxRun}`);
		await overId(h, `p${maxRun + 2}`);
		await expect.poll(() => barIsOn(h)).toBe(false);
		await wheelAt(h, await centerOf(h, `p${maxRun + 2}`), control);
		await h.page.waitForTimeout(latchedMs);
		await keys.up(h, 'Control');
		expect((await takeWheels(h)).some((wheel) => wheel.prevented), 'not claimed').toBe(false);
		expect(await foldedAmong(h, ps(1, maxRun + 3))).toEqual([]);
		expect(errors(h)).toEqual([]);
	});

	test('lane 37: where the line has no room, over a paragraph or from a gap beside it, neither the arrow nor the wheel folds it', async ({ h }) => {
		await h.page.setViewportSize({ width: 1280, height: 2000 });
		await setScrollKey(h, 'ctrl');
		for (const from of ['wide-p', 'above-wide']) {
			await h.page.mouse.move(2, 2);
			await open(h, shapesPage);
			await h.page.evaluate(() => document.getElementById('wide')?.insertAdjacentHTML('beforebegin', '<h3 id="above-wide" style="margin:0">A title</h3>'));
			await logArrows(h);
			await logWheels(h);
			const { top, bottom } = await shownBox(h.page, from);
			const at = { x: 640, y: (top + bottom) / 2 };
			await h.page.mouse.move(at.x, at.y);
			await keys.down(h, ...optionShift);
			await h.page.waitForTimeout(150);
			expect(await barIsOn(h), `no room for a line from ${from}`).toBe(false);
			await pressGoesToPage(h, ['wide-p']);
			await keys.up(h, ...optionShift);

			await keys.down(h, 'Control');
			await h.page.waitForTimeout(beatMs + 150);
			expect(await barIsOn(h), `no line under the scroll key from ${from}`).toBe(false);
			await wheelAt(h, at, control);
			await h.page.waitForTimeout(latchedMs);
			await keys.up(h, 'Control');
			expect((await takeWheels(h)).some((wheel) => wheel.prevented), `the wheel from ${from} is not claimed`).toBe(false);
			expect(await levelOf(h, 'wide-p'), `the wheel from ${from} folds nothing`).toBe(0);
		}
		expect(errors(h)).toEqual([]);
	});
});
