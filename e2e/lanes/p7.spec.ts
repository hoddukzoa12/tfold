import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { CDPSession } from '@playwright/test';
import { localFold } from '../../src/fold/local.ts';
import { presets } from '../../src/fold/providers/presets.ts';
import { en } from '../../src/strings/en.ts';
import { ko } from '../../src/strings/ko.ts';
import { fixtures, foldAt, launch, type Harness, type Point } from '../harness.ts';
import { expect, test } from '../lane.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p7');
const targets = '/gesture-targets/';
const reading = '/reading-en/';
const readingParagraphs = 'article > p:not([data-tfold-overlay])';
const latchedMs = 450;
const alt = 1;
const ctrl = 2;

const worker = (h: Harness) => h.worker;
const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');

async function shot(name: string): Promise<string> {
	await mkdir(outDir, { recursive: true });
	return path.join(outDir, `${name}.png`);
}

const openTargets = async (h: Harness) => {
	await h.navigate(targets);
	await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
};

const session = (h: Harness) => h.context.newCDPSession(h.page);

async function levelOf(h: Harness, selector: string): Promise<number | null> {
	return h.inContent<number | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return (el && globalThis.__tfold.blockAt(el)?.level) ?? null; })()`);
}

const logWheels = (h: Harness) =>
	h.page.evaluate(() => {
		const w = window as unknown as { wheels: { cancelable: boolean; prevented: boolean; target: string }[] };
		w.wheels = [];
		addEventListener('wheel', (event) => {
			const wheel = { cancelable: event.cancelable, prevented: false, target: (event.target as Element).id };
			w.wheels.push(wheel);
			setTimeout(() => (wheel.prevented = event.defaultPrevented));
		});
	});

const takeWheels = (h: Harness) =>
	h.page.evaluate(async () => {
		const w = window as unknown as { wheels: { cancelable: boolean; prevented: boolean; target: string }[] };
		await new Promise((resolve) => setTimeout(resolve));
		return w.wheels.splice(0);
	});

const barState = (h: Harness) =>
	h.page.evaluate(() => {
		const bar = document.querySelector('tf-bar')?.shadowRoot?.querySelector<HTMLElement>('.bar');
		if (!bar) return { on: false, left: 0, top: 0, height: 0, right: 0, bottom: 0 };
		const box = bar.getBoundingClientRect();
		return { on: bar.dataset.on !== undefined, left: box.left, right: box.right, top: box.top, height: box.height, bottom: box.bottom };
	});

const boxOf = (h: Harness, selector: string) =>
	h.page.locator(selector).first().evaluate((el) => {
		const { left, right, top, bottom, width, height } = el.getBoundingClientRect();
		return { left, right, top, bottom, width, height };
	});

async function openSettings(h: Harness) {
	const settings = await h.context.newPage();
	await settings.goto(`chrome-extension://${h.extensionId}/options/options.html`);
	await expect(settings.locator('#sample-level')).not.toBeEmpty();
	return settings;
}

async function chooseModifier(h: Harness, value: 'ctrl' | 'alt' | 'off'): Promise<void> {
	const settings = await openSettings(h);
	await settings.locator(`label:has(input[name="scroll-modifier"][value="${value}"])`).click();
	await expect.poll(() => worker(h).evaluate(async () => (await chrome.storage.local.get('scrollModifier')).scrollModifier)).toBe(value);
	await settings.close();
	await h.page.bringToFront();
	await h.page.waitForTimeout(150);
}

async function firstLine(h: Harness, selector: string): Promise<Point> {
	await h.pointAt(selector);
	const { left, top } = await boxOf(h, selector);
	return { x: left + 50, y: top + 10 };
}

async function pageShot(h: Harness, name: string): Promise<void> {
	await h.page.screenshot({ path: await shot(name) });
}

test.describe('which wheel folds', () => {
	const notch = async (cdp: CDPSession, point: Point, deltaY: number, modifiers: number) => {
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY, modifiers });
		await new Promise((resolve) => setTimeout(resolve, latchedMs));
	};

	test('lane 5: each setting for the scroll key folds with that key and leaves the other to the browser, and a wheel with Control and no key is never claimed', async ({ h }) => {
		test.setTimeout(120_000);
		await openTargets(h);
		await logWheels(h);
		const cdp = await session(h);
		await h.page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
		const point = await firstLine(h, '#long-1');
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
		const measured: Record<string, unknown> = {};
		const run = async (label: string, keys: string | undefined, modifiers: number, expected: { prevented: boolean; levels: number }) => {
			const before = (await levelOf(h, '#long-1')) ?? 0;
			if (keys) await h.page.keyboard.down(keys);
			await notch(cdp, point, 120, modifiers);
			if (keys) await h.page.keyboard.up(keys);
			const wheels = await takeWheels(h);
			measured[label] = { wheels, level: await levelOf(h, '#long-1'), scrollY: await h.page.evaluate(() => scrollY), dpr: await h.page.evaluate(() => devicePixelRatio) };
			expect(wheels.at(-1)?.prevented, `${label} claimed`).toBe(expected.prevented);
			expect(((await levelOf(h, '#long-1')) ?? 0) - before, `${label} levels`).toBe(expected.levels);
			if (expected.levels !== 0) {
				await foldAt(cdp, point.x, point.y, -1);
				await h.page.waitForTimeout(latchedMs);
			}
			await h.page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
		};
		const folds = { prevented: true, levels: 1 };
		const leftAlone = { prevented: false, levels: 0 };

		await run('default: Control and a notch', 'Control', ctrl, folds);
		await run('default: Alt and a notch', 'Alt', alt, leftAlone);
		await run('default: Control set and no key', undefined, ctrl, leftAlone);

		await chooseModifier(h, 'alt');
		await run('alt: Alt and a notch', 'Alt', alt, folds);
		await run('alt: Control and a notch', 'Control', ctrl, leftAlone);
		await run('alt: Control set and no key', undefined, ctrl, leftAlone);

		await chooseModifier(h, 'off');
		await run('off: Control and a notch', 'Control', ctrl, leftAlone);
		await run('off: Alt and a notch', 'Alt', alt, leftAlone);
		await run('off: Control set and no key', undefined, ctrl, leftAlone);

		await chooseModifier(h, 'ctrl');
		await run('back: Control and a notch', 'Control', ctrl, folds);
		console.log(JSON.stringify(measured));
		expect(errors(h)).toEqual([]);
	});

	// The page cannot scroll here and the wheel never crosses a step, so nothing moves under the pointer. If something did,
	// Chromium's own pointerout with no modifiers would pass through, and this lane proves that it must not reset Control.
	test('lane 6: Control counts as held only from its key or a pointer move, and is forgotten by the next pointer move, its key coming up and losing the page', async ({ h }) => {
		await openTargets(h);
		await logWheels(h);
		const cdp = await session(h);
		const point = await firstLine(h, '#long-1');
		await h.page.evaluate(() => {
			document.documentElement.style.overflow = 'hidden';
		});
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
		const wheelIsClaimed = async () => {
			await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 1, modifiers: ctrl });
			await new Promise((resolve) => setTimeout(resolve, latchedMs));
			return (await takeWheels(h)).at(-1)?.prevented;
		};
		const holdControl = async () => {
			await h.page.keyboard.down('Control');
			expect(await wheelIsClaimed(), 'Control down is the scroll key').toBe(true);
		};

		expect(await wheelIsClaimed(), 'Control set with no key seen stays with the browser').toBe(false);
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 1, y: point.y, modifiers: ctrl });
		expect(await wheelIsClaimed(), 'Control seen on a pointer move counts as held').toBe(true);
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 2, y: point.y });
		expect(await wheelIsClaimed(), 'a pointer move with no Control ends it').toBe(false);

		await holdControl();
		await h.page.keyboard.up('Control');
		expect(await wheelIsClaimed(), 'the key coming up ends it').toBe(false);

		await holdControl();
		await h.page.evaluate(() => dispatchEvent(new Event('blur')));
		expect(await wheelIsClaimed(), 'a blur forgets the key').toBe(false);
		await h.page.keyboard.up('Control');

		await h.page.keyboard.down('Control');
		await h.page.keyboard.down('Shift');
		await h.page.evaluate(() => dispatchEvent(new Event('blur')));
		expect(await wheelIsClaimed(), 'a blur forgets Control held in a chord too').toBe(false);
		await h.page.keyboard.up('Shift');
		await h.page.keyboard.up('Control');

		await holdControl();
		await h.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		expect(await wheelIsClaimed(), 'hiding the page forgets the key').toBe(false);
		await h.page.keyboard.up('Control');

		await holdControl();
		const host = new URL(h.page.url()).hostname;
		const setSite = (disabledSites: string[]) =>
			worker(h).evaluate(
				async ({ disabledSites, host }) => {
					await chrome.storage.local.set({ disabledSites });
					const tabs = await chrome.tabs.query({});
					await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id as number, { type: 'site', host }).catch(() => undefined)));
				},
				{ disabledSites, host },
			);
		await setSite([host]);
		await h.page.waitForTimeout(300);
		await h.page.keyboard.up('Control');
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
		await setSite([]);
		await expect.poll(() => wheelIsClaimed(), { message: 'a key let go while the site was off is forgotten' }).toBe(false);
	});

	test('lane 3: a fold that moves the page under a still pointer does not forget Control, so the next notch folds again instead of zooming', async ({ h }) => {
		await openTargets(h);
		await logWheels(h);
		const cdp = await session(h);
		const point = await firstLine(h, '#long-1');
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
		await h.page.keyboard.down('Control');
		await notch(cdp, point, 120, ctrl);
		await notch(cdp, point, 120, ctrl);
		await notch(cdp, point, 120, ctrl);
		await h.page.keyboard.up('Control');
		expect(await levelOf(h, '#long-1'), 'each notch moved one level of the same paragraph').toBe(3);
		expect((await takeWheels(h)).every((wheel) => wheel.prevented), 'no notch reached the browser').toBe(true);
	});

	test('lane 7: away from a Mac, which has no inertial wheel, Control and a notch right after a plain scroll folds instead of zooming', async ({ h }) => {
		await openTargets(h);
		await logWheels(h);
		const cdp = await session(h);
		const point = await h.pointAt('#long-2');
		for (let i = 0; i < 4; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 1 });
		await h.page.keyboard.down('Control');
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 120, modifiers: ctrl });
		await h.page.keyboard.up('Control');
		await expect.poll(() => levelOf(h, '#long-2')).toBe(1);
		expect((await takeWheels(h)).at(-1)?.prevented).toBe(true);
	});
});

test.describe('which paragraph a shortcut folds, and the bar that shows it', () => {
	const press = 'Alt+Shift+ArrowDown';

	test('lane 8: the shortcut goes to the paragraph under the pointer, then the one with focus, then the one nearest the middle, and leaves typing and selections alone', async ({ h }) => {
		test.setTimeout(90_000);
		await openTargets(h);
		const nearest = await h.page.evaluate(() => {
			const middle = { x: innerWidth / 2, y: innerHeight / 2 };
			const distance = (el: Element) => {
				const { left, right, top, bottom } = el.getBoundingClientRect();
				return Math.hypot(Math.max(left - middle.x, 0, middle.x - right), Math.max(top - middle.y, 0, middle.y - bottom));
			};
			return ['long-1', 'long-2', 'long-3'].map((id) => ({ id, distance: distance(document.getElementById(id) as Element) })).sort((a, b) => a.distance - b.distance)[0]?.id;
		});
		await h.press(press);
		expect(await levelOf(h, `#${nearest}`), `with no pointer and no focus, ${nearest} is nearest the middle`).toBe(1);
		await h.press('Alt+Shift+ArrowUp');

		await h.page.locator('#inline-link').focus();
		await h.press(press);
		expect(await levelOf(h, '#long-3'), 'the link inside it has focus').toBe(1);
		await h.press('Alt+Shift+ArrowUp');

		await h.pointAt('#long-1');
		await h.press(press);
		expect(await levelOf(h, '#long-1'), 'the pointer comes first, over focus').toBe(1);
		await h.press('Alt+Shift+ArrowUp');

		const before = (await h.readBlocks()).map((block) => block.level);
		for (const field of ['#field', '#rich']) {
			await h.page.locator(field).focus();
			await h.press(press);
			expect((await h.readBlocks()).map((block) => block.level), `${field} keeps the keys`).toEqual(before);
		}
		await h.page.evaluate(() => (document.activeElement as HTMLElement).blur());
		await h.page.evaluate(() => getSelection()?.selectAllChildren(document.getElementById('long-2') as Element));
		await h.press(press);
		expect((await h.readBlocks()).map((block) => block.level), 'a selection keeps the keys').toEqual(before);
		expect(errors(h)).toEqual([]);
	});

	test('lane 9: holding the shortcut keys marks the target with a bar that moves nothing, and letting go takes it away', async ({ h }) => {
		await openTargets(h);
		const point = await h.pointAt('#long-2');
		await h.page.evaluate(() => {
			const w = window as unknown as { shifted: number };
			w.shifted = 0;
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) w.shifted += (entry as unknown as { value: number }).value;
			}).observe({ type: 'layout-shift' });
		});
		const boxes = () => h.page.locator('p, h1, h2, li').evaluateAll((all) => all.map((el) => { const { left, top, width, height } = el.getBoundingClientRect(); return [left, top, width, height]; }));
		const measures = () => h.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]);
		const [boxesBefore, sizeBefore] = [await boxes(), await measures()];

		await h.page.keyboard.down('Alt');
		await h.page.keyboard.down('Shift');
		await expect.poll(async () => (await barState(h)).on, { message: 'the bar shows once both keys are held' }).toBe(true);
		const target = await boxOf(h, '#long-2');
		const bar = await barState(h);
		expect(bar.right, 'beside the text').toBeLessThanOrEqual(target.left);
		expect(Math.abs(bar.top - target.top), 'level with the text').toBeLessThanOrEqual(1);
		expect(Math.abs(bar.height - target.height), 'as tall as the text').toBeLessThanOrEqual(2);
		await pageShot(h, 'p7-bar-light');
		expect(await boxes(), 'nothing moved').toEqual(boxesBefore);
		expect(await measures(), 'the page did not grow').toEqual(sizeBefore);

		const nextTop = (await boxOf(h, '#long-1')).top;
		await h.page.mouse.move(point.x, nextTop + 10);
		await expect.poll(async () => Math.abs((await barState(h)).top - nextTop), { message: 'the bar follows the pointer' }).toBeLessThanOrEqual(1);

		await h.page.keyboard.up('Shift');
		await expect.poll(async () => (await barState(h)).on, { message: 'letting go of a key takes it away' }).toBe(false);
		await h.page.keyboard.up('Alt');

		await h.page.keyboard.down('Alt');
		await h.page.keyboard.down('Shift');
		await h.page.evaluate(() => document.getElementById('field')?.focus());
		await h.page.keyboard.press('ArrowLeft');
		await expect.poll(async () => (await barState(h)).on, { message: 'a focused field has no bar' }).toBe(false);
		await h.page.keyboard.up('Shift');
		await h.page.keyboard.up('Alt');

		expect(await h.page.evaluate(() => (window as unknown as { shifted: number }).shifted), 'zero layout shift').toBe(0);
		expect(errors(h)).toEqual([]);
	});

	test('lane 10: the bar reads on white and on a dark page, with and without motion, and sits on the side a paragraph starts from', async ({ h }) => {
		await openTargets(h);
		await h.pointAt('#long-2');
		const holdKeys = async () => {
			await h.page.keyboard.down('Alt');
			await h.page.keyboard.down('Shift');
			await expect.poll(async () => (await barState(h)).on).toBe(true);
		};
		const letGo = async () => {
			await h.page.keyboard.up('Shift');
			await h.page.keyboard.up('Alt');
			await expect.poll(async () => (await barState(h)).on, { message: 'gone once the keys are let go' }).toBe(false);
		};
		const ratio = (a: number[], b: number[]) => {
			const lum = (c: number[]) => {
				const [r = 0, g = 0, bl = 0] = c.map((v) => {
					const s = v / 255;
					return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
				});
				return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
			};
			const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
			return (hi + 0.05) / (lo + 0.05);
		};
		const rgb = (css: string) => (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
		const paint = () =>
			h.page.evaluate(() => {
				const bar = document.querySelector('tf-bar')?.shadowRoot?.querySelector('.bar') as Element;
				const style = getComputedStyle(bar);
				return { fill: style.backgroundColor, edge: style.boxShadow, transition: style.transitionDuration };
			});
		await holdKeys();
		const painted = await paint();
		await letGo();

		const white = [255, 255, 255];
		const dark = [13, 17, 23];
		const seen = {
			edgeOnWhite: ratio(rgb(painted.edge), white),
			fillOnDark: ratio(rgb(painted.fill), dark),
			fillOnWhite: ratio(rgb(painted.fill), white),
		};
		console.log(JSON.stringify(seen));
		expect(seen.edgeOnWhite, 'the edge carries the bar on white').toBeGreaterThanOrEqual(3);
		expect(seen.fillOnDark, 'the fill carries the bar on dark').toBeGreaterThanOrEqual(3);

		await h.page.emulateMedia({ reducedMotion: 'reduce' });
		await holdKeys();
		expect((await paint()).transition).toBe('0s');
		await letGo();
		await h.page.emulateMedia({ reducedMotion: 'no-preference' });

		await h.page.evaluate(() => document.body.classList.add('dark'));
		await holdKeys();
		await pageShot(h, 'p7-bar-dark');
		await letGo();

		await h.pointAt('#rtl');
		await holdKeys();
		await expect.poll(async () => (await barState(h)).left).toBeGreaterThanOrEqual((await boxOf(h, '#rtl')).right);
		await letGo();
		expect(errors(h)).toEqual([]);
	});
});

const passPage = '/gesture-pass/';
const editorsPage = '/gesture-pass/editors.html';
const ownWheelPage = '/gesture-pass/own-wheel.html';
const barPage = '/gesture-pass/bar.html';

async function open(h: Harness, url: string): Promise<void> {
	await h.navigate(url);
	await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
}

test.describe('what a scroll leaves to the page', () => {
	const wheelWithControl = async (h: Harness, cdp: CDPSession, point: Point) => {
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
		await h.page.keyboard.down('Control');
		await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 120, modifiers: ctrl });
		await h.page.waitForTimeout(latchedMs);
		await h.page.keyboard.up('Control');
		return (await takeWheels(h)).at(-1)?.prevented;
	};
	const levels = async (h: Harness) => (await h.readBlocks()).map((block) => block.level);

	test('lane 18: Ctrl and a wheel over anything but a paragraph goes to the browser, and over a paragraph, its links, its small images and its quote folds', async ({ h }) => {
		test.setTimeout(120_000);
		await openTargets(h);
		await logWheels(h);
		const cdp = await session(h);
		const before = await levels(h);
		for (const selector of ['#heading', '#subheading', '#short', '#short-item', '#photo', '#inner-photo', '#inner-field', '#canvas', '#field', '#rich', '#table td', '#button', '#nav span', '#footer']) {
			expect.soft(await wheelWithControl(h, cdp, await h.pointAt(selector)), `over ${selector}`).toBe(false);
		}
		await h.pointAt('#long-1');
		const [first, second] = [await boxOf(h, '#long-1'), await boxOf(h, '#long-2')];
		expect(await wheelWithControl(h, cdp, { x: first.left + 100, y: (first.bottom + second.top) / 2 }), 'over a gap').toBe(false);
		expect(await wheelWithControl(h, cdp, { x: first.left - 20, y: (first.top + first.bottom) / 2 }), 'in a margin').toBe(false);
		expect(await levels(h), 'nothing folded').toEqual(before);

		for (const selector of ['#long-1', '#inline-link', '#inline-mark', '#quote']) {
			expect.soft(await wheelWithControl(h, cdp, await h.pointAt(selector)), `over ${selector}`).toBe(true);
		}
		expect(errors(h)).toEqual([]);
	});

	test('lane 19: in an article full of folds, text on a photo, a video, a chart or a map, a caption, a cell and a heading all stay with the browser, and the paragraphs still fold', async ({ h }) => {
		test.setTimeout(120_000);
		await open(h, passPage);
		await logWheels(h);
		const cdp = await session(h);
		const before = await levels(h);
		for (const selector of ['#title', '#note', '#sub', '#hero-img-title', '#hero-bg-title', '#video-subtitle', '#canvas-subtitle', '#chart-axis', '#map-place', '#gallery-caption', '#lone-caption', '#grid-cell', '#grid-p', '#short-item']) {
			expect.soft(await wheelWithControl(h, cdp, await h.pointAt(selector)), `over ${selector}`).toBe(false);
		}
		expect(await levels(h), 'nothing folded').toEqual(before);
		for (const selector of ['#a1', '#a4', '#a8', '#a10', '#grid-long']) {
			await wheelWithControl(h, cdp, await h.pointAt(selector));
			expect.soft(await levelOf(h, selector), `${selector} folds`).toBe(1);
		}
		expect(errors(h)).toEqual([]);
	});

	test('lane 21: a line of code is never a block, and the keys stay with every editor', async ({ h }) => {
		await open(h, editorsPage);
		for (const selector of ['#ace-prose', '#monaco-prose', '#cm6-line', '#role-application-text', '#role-code-text']) {
			expect.soft(await levelOf(h, selector), `${selector} is not a block`).toBeNull();
		}
		const before = await levels(h);
		expect(before.every((level) => level === 0)).toBe(true);
		for (const field of ['#cm5-input', '#ace-input', '#monaco-input', '#cm6-content', '#role-textbox', '#role-searchbox', '#role-combobox', '#role-application', '#role-code']) {
			await h.page.locator(field).first().focus();
			await h.press('Alt+Shift+ArrowDown');
			expect.soft(await levels(h), `${field} keeps the keys`).toEqual(before);
		}
		await h.page.evaluate(() => (document.activeElement as HTMLElement).blur());
		await h.press('Alt+Shift+ArrowDown');
		expect((await levels(h)).filter((level) => level === 1), 'with nothing focused the keys fold a paragraph, not a line of code').toHaveLength(1);
		expect(errors(h)).toEqual([]);
	});

	test('lane 22: a page that takes the wheel for itself keeps the whole gesture with nothing folded, and a page that only listens reads each event before tfold acts', async ({ h }) => {
		await open(h, ownWheelPage);
		const cdp = await session(h);
		const viewer = () => h.page.evaluate(() => (window as unknown as { viewer: { wheels: number; sawPrevented: number; zoom: number } }).viewer);
		for (const selector of ['#prose', '#short', '#heading', '#sheet-text']) {
			const { wheels } = await viewer();
			const point = await h.pointAt(selector);
			await h.page.keyboard.down('Control');
			await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -120, modifiers: ctrl });
			await h.page.waitForTimeout(latchedMs);
			await h.page.keyboard.up('Control');
			const after = await viewer();
			expect.soft(after.wheels, `${selector} reaches the viewer`).toBeGreaterThan(wheels);
			expect.soft(after.sawPrevented, `${selector} arrives unclaimed`).toBe(0);
		}
		expect(await levelOf(h, '#prose'), 'nothing folded under the viewer').toBe(0);

		await open(h, targets);
		await h.page.evaluate(() => {
			const w = window as unknown as { read: { wheels: number; sawPrevented: number } };
			w.read = { wheels: 0, sawPrevented: 0 };
			document.addEventListener('wheel', (event) => {
				w.read.wheels++;
				if (event.defaultPrevented) w.read.sawPrevented++;
			});
			document.getElementById('long-2')?.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
		});
		const fold = async (selector: string) => {
			const { x, y } = await h.pointAt(selector);
			await foldAt(cdp, x, y, 1);
			await h.page.waitForTimeout(latchedMs);
		};
		await fold('#long-1');
		const read = await h.page.evaluate(() => (window as unknown as { read: { wheels: number; sawPrevented: number } }).read);
		expect(read.wheels, 'a page that only listens sees the gesture').toBeGreaterThan(0);
		expect(read.sawPrevented, 'a handler that honors defaultPrevented is never shut out').toBe(0);
		expect(await levelOf(h, '#long-1'), 'a page that only listens still folds').toBe(1);
		await fold('#long-2');
		expect(await levelOf(h, '#long-2'), 'a listener on one paragraph that prevents the default keeps it').toBe(0);
		expect(errors(h)).toEqual([]);
	});
});


test.describe('the keys around a window laid over the page', () => {
	const press = 'Alt+Shift+ArrowDown';
	const allOpen = (h: Harness) => h.readBlocks().then((blocks) => blocks.every((block) => block.level === 0));
	const lay = (h: Harness, html: string) =>
		h.page.evaluate((html) => {
			document.body.insertAdjacentHTML('beforeend', html);
			const laid = document.getElementById('laid');
			if (laid instanceof HTMLDialogElement && !laid.open) laid.showModal();
		}, html);
	const lift = (h: Harness) => h.page.evaluate(() => document.getElementById('laid')?.remove());

	test('lane 24: with a dialog open the fallback folds nothing behind it, a closed one changes nothing, and a paragraph covered at its middle is passed over', async ({ h }) => {
		await openTargets(h);
		const windows: [string, string][] = [
			['a modal dialog', '<dialog id="laid"><p>Are you sure about the pier?</p></dialog>'],
			['a non-modal open dialog', '<dialog id="laid" open style="position:fixed;top:0"><p>Are you sure about the pier?</p></dialog>'],
			['a dialog role with a backdrop', '<div id="laid" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><p>Are you sure about the pier?</p></div>'],
			['an alert dialog role', '<div id="laid" role="alertdialog" style="position:fixed;top:40%;left:30%;width:40%;height:20%;background:#fff"><p>The pier is closed.</p></div>'],
			['a modal with its focus inside', '<div id="laid" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff"><button>Close</button></div>'],
		];
		for (const [name, html] of windows) {
			await lay(h, html);
			await h.page.evaluate(() => document.querySelector<HTMLElement>('#laid button')?.focus());
			await h.press(press);
			expect.soft(await allOpen(h), `${name} keeps the page as it is`).toBe(true);
			await lift(h);
		}

		await lay(h, '<div id="laid" role="dialog" hidden><p>Not shown.</p></div>');
		await h.press(press);
		expect(await allOpen(h), 'a dialog that is not showing changes nothing').toBe(false);
		await lift(h);
		await h.press('Alt+Shift+ArrowUp');
		expect(await allOpen(h)).toBe(true);

		const middle = await h.page.evaluate(() => {
			const [x, y] = [innerWidth / 2, innerHeight / 2];
			const nearest = [...document.querySelectorAll('.col > p')]
				.map((el) => ({ el, box: el.getBoundingClientRect() }))
				.map(({ el, box }) => ({ id: el.id, top: box.top, height: box.height, distance: Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom)) }))
				.sort((a, b) => a.distance - b.distance)[0];
			return nearest as { id: string; top: number; height: number };
		});
		await lay(h, `<div id="laid" style="position:fixed;left:0;right:0;top:${middle.top}px;height:${middle.height}px;background:#fff"></div>`);
		await h.press(press);
		expect(await levelOf(h, `#${middle.id}`), 'the paragraph under the cover is not folded').toBe(0);
		expect(await allOpen(h), 'the next paragraph that can be hit is').toBe(false);
		await lift(h);
		expect(errors(h)).toEqual([]);
	});
});

test.describe('where the bar sits', () => {
	const hold = async (h: Harness, selector: string) => {
		await h.pointAt(selector);
		await h.page.keyboard.down('Alt');
		await h.page.keyboard.down('Shift');
		await expect.poll(async () => (await barState(h)).on, { message: `the bar shows for ${selector}` }).toBe(true);
		await h.page.waitForTimeout(100);
	};
	const letGo = async (h: Harness) => {
		await h.page.keyboard.up('Shift');
		await h.page.keyboard.up('Alt');
		await expect.poll(async () => (await barState(h)).on).toBe(false);
	};
	const coveredText = (h: Harness, selector: string, bar: { left: number; right: number; top: number; bottom: number }) =>
		h.page.locator(selector).evaluate((el, bar) => {
			const range = document.createRange();
			range.selectNodeContents(el);
			const overlap = [...range.getClientRects()].map((line) => Math.min(line.right, bar.right) - Math.max(line.left, bar.left) > 0 && Math.min(line.bottom, bar.bottom) - Math.max(line.top, bar.top) > 0);
			return overlap.filter(Boolean).length;
		}, bar);

	test('lane 25: on a block with no margin the bar stays clear of its text, in a pane the bar stays inside the pane, and nothing moves', async ({ h }) => {
		await open(h, barPage);
		const measures = () => h.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]);
		const sizeBefore = await measures();
		const window = await h.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));

		for (const selector of ['#flush', '#narrow']) {
			await hold(h, selector);
			const bar = await barState(h);
			console.log(selector, JSON.stringify(bar));
			expect.soft(await coveredText(h, selector, bar), `${selector} has no line under the bar`).toBe(0);
			expect.soft(bar.left, `${selector} inside the window`).toBeGreaterThanOrEqual(0);
			expect.soft(bar.right, `${selector} inside the window`).toBeLessThanOrEqual(window.width);
			await pageShot(h, `p7-bar-${selector.slice(1)}`);
			await letGo(h);
		}

		await hold(h, '#pane-long');
		let pane = await boxOf(h, '#pane');
		let bar = await barState(h);
		console.log('#pane-long', JSON.stringify({ bar, pane }));
		expect.soft(bar.top, 'starts inside the pane').toBeGreaterThanOrEqual(pane.top);
		expect.soft(bar.bottom, 'stops inside the pane').toBeLessThanOrEqual(pane.bottom);
		expect.soft(await coveredText(h, '#pane-long', bar), 'clear of the text').toBe(0);
		await pageShot(h, 'p7-bar-pane');
		await letGo(h);

		await h.page.locator('#pane').evaluate((el) => (el.scrollTop = el.scrollHeight));
		await hold(h, '#pane-next');
		pane = await boxOf(h, '#pane');
		bar = await barState(h);
		expect.soft(bar.top, 'starts inside the pane').toBeGreaterThanOrEqual(pane.top);
		expect.soft(bar.bottom, 'stops inside the pane').toBeLessThanOrEqual(pane.bottom);
		expect.soft(await coveredText(h, '#pane-next', bar), 'clear of the text').toBe(0);
		await letGo(h);

		await hold(h, '#side-text');
		const side = await boxOf(h, '#side-pane');
		bar = await barState(h);
		console.log('#side-text', JSON.stringify({ bar, side }));
		expect.soft(bar.left, 'stays out of the sidebar').toBeGreaterThanOrEqual(side.left);
		expect.soft(bar.right, 'stays in its pane').toBeLessThanOrEqual(side.right);
		expect.soft(await coveredText(h, '#side-text', bar), 'clear of the text').toBe(0);
		await letGo(h);

		expect(await measures(), 'the page did not grow').toEqual(sizeBefore);
		expect(errors(h)).toEqual([]);
	});
});


test.describe('the settings sample', () => {
	const sampleText = (page: Awaited<ReturnType<typeof openSettings>>) => page.evaluate(() => (document.querySelector('#sample-stage [data-tfold-overlay]') ?? document.getElementById('sample-text'))?.textContent?.replace(/\s+/g, ' ').trim());

	test('lane 12: a reader with no AI sees the real quick fold, with quick and AI side by side at level 2 as a labeled example; a reader with AI keeps the written levels; nothing asks a model', async ({ headless }) => {
		test.setTimeout(150_000);
		for (const [lang, table] of [['en', en], ['ko', ko]] as const) {
			const h = await launch({ headless, lang });
			try {
				const settings = await openSettings(h);
				await settings.setViewportSize({ width: 860, height: 900 });
				const cdp = await settings.context().newCDPSession(settings);
				const point = await settings.locator('#sample-text').evaluate((el) => {
					const { left, width, top } = el.getBoundingClientRect();
					return { x: left + width / 2, y: top + 24 };
				});
				const fold = async () => {
					await foldAt(cdp, point.x, point.y, 1);
					await settings.waitForTimeout(latchedMs);
				};
				const full = table.sampleFold.sentences.join(' ');
				const quick = localFold(full);
				expect(await sampleText(settings)).toBe(full);
				await expect(settings.locator('#sample-compare')).toBeHidden();

				await fold();
				await expect.poll(() => sampleText(settings), { message: `${lang} level 1 is the real first sentence` }).toBe(quick.sentences[0]);
				await expect(settings.locator('#sample-level')).toContainText(table.sampleQuickLevels[1].about);
				await expect(settings.locator('#sample-compare')).toBeHidden();

				await fold();
				await expect.poll(() => sampleText(settings), { message: `${lang} level 2 is the real quick text` }).toBe(quick.key);
				const compare = settings.locator('#sample-compare');
				await expect(compare).toBeVisible();
				await expect(settings.locator('#sample-compare-quick')).toHaveText(quick.key);
				await expect(settings.locator('#sample-compare-ai')).toHaveText(table.sampleFold.key);
				await expect(compare).toContainText(table.compareAi);
				const [a, b] = await compare.locator(':scope > div').evaluateAll((columns) => columns.map((column) => column.getBoundingClientRect().left));
				expect(b, 'side by side').toBeGreaterThan(a as number);
				await settings.locator('#sample-section').screenshot({ path: await shot(`p7-sample-compare-${lang}`) });

				await fold();
				await expect.poll(() => sampleText(settings), { message: `${lang} level 3 is the real quick text` }).toBe(quick.takeaway);
				await expect(compare).toBeHidden();

				await worker(h).evaluate(() => chrome.storage.local.set({ providers: { chosen: 'opengateway', opengateway: { apiKey: 'sample-key', baseUrl: 'https://invalid.example', model: 'x/y' } } }));
				await expect.poll(() => settings.locator('#sample-level').textContent()).toContain(table.sampleLevels[0].name);
				await fold();
				await fold();
				await expect.poll(() => sampleText(settings), { message: `${lang} with AI level 2 keeps the written text` }).toBe(table.sampleFold.key);
				await expect(settings.locator('#sample-level')).toContainText(table.sampleLevels[2].about);
				await expect(compare, `${lang} with AI has nothing to compare`).toBeHidden();
				expect(h.logs.filter((entry) => entry.text.startsWith('fold received')), `${lang} no model call`).toEqual([]);
				expect(errors(h)).toEqual([]);
			} finally {
				await h.close();
			}
		}
	});
});

test.describe('the popup on first run', () => {
	test('lane 13: before the first fold the how-to leads and add a key is a link, after it the link is promoted, and with the site off the key pitch is gone', async ({ h }) => {
		await h.navigate(fixtures.wiki);
		const read = `(() => {
			const shown = (id) => document.getElementById(id)?.checkVisibility() === true;
			const howTo = document.getElementById('how-to');
			const row = document.getElementById('provider-row');
			return {
				howToFirst: (howTo.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
				addKey: shown('add-key') ? (document.getElementById('add-key').classList.contains('primary') ? 'lime button' : 'text link') : null,
				state: shown('provider-state') ? document.getElementById('provider-state').textContent : null,
				title: document.getElementById('provider-title').textContent,
				scroll: shown('scroll-keys') ? document.getElementById('scroll-keys').textContent : null,
			};
		})()`;
		const seen = async () => {
			const popup = await h.openPopup();
			const state = await popup.evaluate<Record<string, unknown>>(read);
			await popup.close();
			return state;
		};
		expect(await seen()).toMatchObject({ howToFirst: true, addKey: 'text link', state: en.popupNoKeyBody('OpenGateway'), scroll: 'Ctrl+scroll ↓ ↑' });

		await worker(h).evaluate(() => chrome.storage.local.set({ hasFolded: true }));
		expect(await seen()).toMatchObject({ howToFirst: false, addKey: 'lime button', state: en.popupNoKeyBody('OpenGateway') });

		await worker(h).evaluate(() => chrome.storage.local.set({ scrollModifier: 'alt' }));
		expect(await seen()).toMatchObject({ scroll: 'Alt+scroll ↓ ↑' });
		await worker(h).evaluate(() => chrome.storage.local.set({ scrollModifier: 'off' }));
		expect(await seen()).toMatchObject({ scroll: null });

		await worker(h).evaluate((host) => chrome.storage.local.set({ disabledSites: [host] }), new URL(h.page.url()).hostname);
		expect(await seen()).toMatchObject({ title: en.popupSiteOff, addKey: null, state: null });
		expect(errors(h)).toEqual([]);
	});
});

type Mock = { baseUrl: string; calls: number[]; close(): Promise<void> };

async function slowProvider(delayMs: number): Promise<Mock> {
	const calls: number[] = [];
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
			const units = [...prompt.matchAll(/^\[U(\d+)\]/gm)].map(([, n]) => ({ id: `U${n}`, takeaway: '짧게 줄인 번역 문장이에요', reason: '이 문단의 요점을 번역해서 적은 문장이에요', evidence: [0] }));
			calls.push(units.length);
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

const translated = { autoTranslate: true, readerLanguage: 'ko' };

async function seedTranslating(h: Harness, providers: object): Promise<void> {
	await h.worker.evaluate(
		async ({ providers, translated }) => {
			await chrome.storage.local.set({ providers, hintSeen: true });
			await chrome.storage.sync.set(translated);
		},
		{ providers, translated },
	);
}

type Read = { folds: { shows: string | null; waitedMs: number | null }[] };

async function readParagraphs(h: Harness, count: number, readingMs: number, answerWaitMs: number): Promise<Read> {
	await h.navigate(reading);
	await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
	const folds: Read['folds'] = [];
	for (let i = 0; i < count; i++) {
		const selector = `${readingParagraphs} >> nth=${i}`;
		const { x, y } = await h.pointAt(selector);
		await h.foldAt(x, y, 2);
		const started = Date.now();
		const overlayFold = () => h.page.evaluate(({ all, i }) => document.querySelectorAll(all)[i]?.nextElementSibling?.getAttribute('data-tf-fold') ?? null, { all: readingParagraphs, i });
		const shows = await overlayFold();
		let waitedMs: number | null = shows === 'model' ? 0 : null;
		if (shows !== 'model') {
			for (; Date.now() - started < answerWaitMs; await h.page.waitForTimeout(20)) {
				if ((await overlayFold()) === 'model') {
					waitedMs = Date.now() - started;
					break;
				}
			}
		}
		folds.push({ shows, waitedMs });
		await h.page.waitForTimeout(Math.max(0, readingMs - (Date.now() - started)));
	}
	return { folds };
}

const originals = ({ folds }: Read) => folds.filter((fold) => fold.shows !== 'model').length;

test.describe('asking ahead with translation on', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	test('lane 14: over a 12-paragraph read the next window is on its way before the fold needs it, so only the first fold shows the original, each window stays at 3, and scrolling with no fold asks for nothing more', async ({ headless }) => {
		test.setTimeout(120_000);
		const delayMs = 1500;
		const readingMs = 2500;
		const slow = await slowProvider(delayMs);
		const reader = await launch({ headless, allowLiveHosts: ['127.0.0.1'] });
		try {
			await seedTranslating(reader, { chosen: 'openrouter', openrouter: { apiKey: 'mock', baseUrl: slow.baseUrl, model: 'mock/model' } });
			const read = await readParagraphs(reader, 12, readingMs, delayMs + 1000);
			console.log(JSON.stringify({ calls: slow.calls.length, paragraphs: slow.calls.reduce((a, b) => a + b, 0), showedOriginal: originals(read), windows: slow.calls }));
			expect(slow.calls.every((size) => size <= 3), 'the window stays at 3').toBe(true);
			expect(originals(read), 'only the first').toBe(1);
		} finally {
			await reader.close();
			await slow.close();
		}

		const mock = await slowProvider(50);
		const h = await launch({ headless, allowLiveHosts: ['127.0.0.1'] });
		try {
			await seedTranslating(h, { chosen: 'openrouter', openrouter: { apiKey: 'mock', baseUrl: mock.baseUrl, model: 'mock/model' } });
			await h.navigate(reading);
			await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
			const { x, y } = await h.pointAt(`${readingParagraphs} >> nth=0`);
			await h.foldAt(x, y, 2);
			await h.page.waitForTimeout(300);
			const afterFold = mock.calls.length;
			const total = await h.page.evaluate(() => document.documentElement.scrollHeight);
			for (let top = 0; top < total; top += 300) {
				await h.page.evaluate((top) => scrollTo(0, top), top);
				await h.page.waitForTimeout(40);
			}
			await h.page.waitForTimeout(300);
			console.log(`one fold then a scroll to the end: ${afterFold} calls after the fold, ${mock.calls.length} after the scroll`);
			expect(mock.calls.length, 'a fold pays for one window ahead').toBeLessThanOrEqual(afterFold + 1);
		} finally {
			await h.close();
			await mock.close();
		}
	});

	test('lane 15: a scroll too small to fold sends nothing, a request that fails stops asking ahead, and a page with no translation never asks ahead', async ({ headless }) => {
		const mock = await slowProvider(20);
		const h = await launch({ headless, allowLiveHosts: ['127.0.0.1'] });
		try {
			await h.worker.evaluate(({ baseUrl }) => chrome.storage.local.set({ providers: { chosen: 'openrouter', openrouter: { apiKey: 'mock', baseUrl, model: 'mock/model' } }, hintSeen: true }), { baseUrl: mock.baseUrl });
			await h.navigate(reading);
			await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
			const small = await h.pointAt(`${readingParagraphs} >> nth=0`);
			await h.page.keyboard.down('Control');
			await (await session(h)).send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...small, deltaX: 0, deltaY: 10, modifiers: ctrl });
			await h.page.keyboard.up('Control');
			await h.page.waitForTimeout(latchedMs);
			expect(mock.calls, 'no fold, so no text leaves the browser').toHaveLength(0);
			for (const i of [0, 1]) {
				const { x, y } = await h.pointAt(`${readingParagraphs} >> nth=${i}`);
				await h.foldAt(x, y, 1);
				await h.page.waitForTimeout(latchedMs);
			}
			await h.page.waitForTimeout(200);
			expect(mock.calls, 'untranslated, two folds in one window of up to 8 ask once').toHaveLength(1);
		} finally {
			await h.close();
			await mock.close();
		}

		const pro = await launch({ headless, account: { kind: 'pro', remainingPercent: 50, resetsAt: new Date(Date.now() + 86_400_000).toISOString() } });
		try {
			await pro.worker.evaluate((translated) => chrome.storage.sync.set(translated), translated);
			await pro.navigate(reading);
			await expect.poll(() => pro.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
			for (const i of [0, 1, 2]) {
				const { x, y } = await pro.pointAt(`${readingParagraphs} >> nth=${i}`);
				await pro.foldAt(x, y, 1);
				await pro.page.waitForTimeout(latchedMs);
			}
			const asked = pro.logs.filter((entry) => entry.text.startsWith('fold skipped, quick summaries only')).length;
			console.log(`three folds on Pro, which has no server yet: ${asked} messages to the worker`);
			expect(asked, 'the first answer stops the asking ahead').toBeLessThanOrEqual(3);
		} finally {
			await pro.close();
		}
	});

	const liveKey = process.env.OPENROUTER_API_KEY ?? '';
	const liveHost = new URL(presets.openrouter.baseUrl).hostname;
	const livePrice = { input: 0.3e-6, output: 1.2e-6 };
	const failedCallAtMost = 1500 * livePrice.input + 850 * livePrice.output;

	test('lane 16, live: a real 12-paragraph read in Korean, with what each fold waited and what it cost', async ({ headless }) => {
		test.skip(liveKey === '', 'needs a provider key');
		test.setTimeout(240_000);
		const h = await launch({ headless, allowLiveHosts: [liveHost] });
		try {
			await seedTranslating(h, { chosen: 'openrouter', openrouter: { apiKey: liveKey, baseUrl: presets.openrouter.baseUrl, model: presets.openrouter.model } });
			const read = await readParagraphs(h, 12, 6000, 12_000);
			await h.page.waitForTimeout(4000);
			const usage = h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('fold usage ')).map((entry) => JSON.parse(entry.text.slice('fold usage '.length)) as { promptTokens: number; completionTokens: number; blocks: number; ms: number });
			const failed = h.logs.filter((entry) => entry.source === 'worker' && /^fold (failed|fallback)/.test(entry.text)).map((entry) => entry.text.slice(0, 160));
			const cost = usage.reduce((sum, call) => sum + call.promptTokens * livePrice.input + call.completionTokens * livePrice.output, failed.length * failedCallAtMost);
			const waits = read.folds.map((fold) => fold.waitedMs);
			console.log(JSON.stringify({ calls: usage.length, blocks: usage.map((call) => call.blocks), ms: usage.map((call) => call.ms), showedOriginal: originals(read), waits, failed, cost: Number(cost.toFixed(5)) }));
			expect(cost, 'inside the budget').toBeLessThan(0.1);
		} finally {
			await h.close();
		}
	});
});

test.describe('what the bar costs', () => {
	type Cost = { taskMs: number; scriptMs: number; layouts: number; styles: number };

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

	const altShift = 1 | 8;
	const moves = async (cdp: CDPSession) => {
		for (let i = 0; i < 300; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200 + (i % 600), y: 100 + (i % 400), modifiers: altShift });
	};

	test('lane 17: 300 pointer moves with the keys held average under 16 ms each', async ({ h }) => {
		await h.navigate(fixtures.wiki);
		await expect.poll(() => h.inContent('typeof globalThis.__tfold').catch(() => null)).toBe('object');
		await h.pointAt('#mw-content-text section > p:not(.mw-empty-elt) >> nth=1');
		await h.page.keyboard.down('Alt');
		await h.page.keyboard.down('Shift');
		await h.page.waitForTimeout(300);
		const held = await measure(h, moves);
		await h.page.keyboard.up('Shift');
		await h.page.keyboard.up('Alt');
		console.log(`300 pointer moves with the keys held: ${JSON.stringify(held)}`);
		expect(held.taskMs, 'an average under 16 ms for each move').toBeLessThan(300 * 16);
	});
});
