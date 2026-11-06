import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { defaultShortcuts } from '../shortcuts.ts';

type Reads = { styles: number; values: number };
type Seen = { reads: Reads; overlayWrites: number };
type Tf = { __tfold: { readBlocks(): { id: string }[]; setLevel(id: string, level: number): void } };

let browser: Browser;
let contentScript: string;

beforeAll(async () => {
	const bundle = build({ entryPoints: [path.join(import.meta.dirname, 'index.ts')], bundle: true, format: 'iife', target: 'chrome120', define: { TFOLD_EDITION: '"store"', TFOLD_DEV: 'false' }, write: false });
	[browser, contentScript] = await Promise.all([chromium.launch(), bundle.then((result) => result.outputFiles[0]?.text ?? '')]);
});

afterAll(async () => {
	await browser.close();
});

const notePage = `<style>
body { color: #111; background: #fff; }
#note { background-color: #fff4c2; color: #222; }
.night #note { background-color: #3a2f05; color: #eee; }
</style>
<div id="wrapper"><p id="note">A note long enough to fold, with <a href="#x">one link</a> in it. It has two sentences so a fold of it keeps some words.</p><div id="beside">Text beside it</div></div>
<div id="elsewhere">Text elsewhere</div>`;

const counters = `(() => {
	const reads = { styles: 0, values: 0 };
	Object.assign(globalThis, { reads, overlayWrites: 0 });
	const computed = globalThis.getComputedStyle;
	globalThis.getComputedStyle = (...args) => {
		reads.styles++;
		return computed(...args);
	};
	const value = CSSStyleDeclaration.prototype.getPropertyValue;
	CSSStyleDeclaration.prototype.getPropertyValue = function (name) {
		reads.values++;
		return value.call(this, name);
	};
})()`;

const inFrames = (change: string, frames: number) => `(async () => {
	${change};
	await Promise.resolve();
	for (let frame = 0; frame < ${frames}; frame++) await new Promise(requestAnimationFrame);
})()`;

async function foldedPage(html = notePage, level = 2): Promise<Page> {
	const page = await browser.newPage();
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setContent(html);
	await page.evaluate((shortcuts) => {
		const replies: Record<string, unknown> = { page: { on: true, hint: false, shortcuts }, fold: { ok: false, error: 'no-key' } };
		const sendMessage = (message: { type: string }) => Promise.resolve(replies[message.type]);
		const storage = { sync: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } };
		Object.assign(globalThis, { chrome: { runtime: { id: 'tfold', sendMessage, onMessage: { addListener() {} } }, i18n: { getUILanguage: () => 'en' }, storage } });
	}, defaultShortcuts);
	await page.evaluate(counters);
	await page.addScriptTag({ content: contentScript });
	await page.evaluate((level) => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [block] = tf.readBlocks();
		if (block) tf.setLevel(block.id, level);
	}, level);
	await expect.poll(() => page.evaluate(() => document.querySelector('[data-tf-badge]') !== null)).toBe(true);
	await page.evaluate(inFrames('', 3));
	await page.evaluate(() => {
		new MutationObserver((records) => {
			(globalThis as unknown as { overlayWrites: number }).overlayWrites += records.filter(({ target }) => (target instanceof Element ? target : target.parentElement)?.closest('[data-tfold-overlay]')).length;
		}).observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
	});
	return page;
}

const foldInk = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector('[data-tfold-overlay]') as Element).webkitTextFillColor);
const foldStyle = (page: Page) => page.evaluate(() => document.querySelector('[data-tfold-overlay]')?.getAttribute('style') ?? '');

// What a change makes the fold read and write, counted until a few frames after it.
async function afterChange(page: Page, change: string, frames = 3): Promise<Seen> {
	const counted = () => page.evaluate(() => {
		const { reads, overlayWrites } = globalThis as unknown as Seen;
		return { reads: { ...reads }, overlayWrites };
	});
	const before = await counted();
	await page.evaluate(inFrames(change, frames));
	const after = await counted();
	return { reads: { styles: after.reads.styles - before.reads.styles, values: after.reads.values - before.reads.values }, overlayWrites: after.overlayWrites - before.overlayWrites };
}

const touchWrapper = "document.getElementById('wrapper').setAttribute('style', 'transform: translateY(1px)')";

test.each<[string, string]>([
	['text beside it changes', "document.getElementById('beside').textContent = 'Other text'"],
	['a child is added beside it', "document.getElementById('beside').append(document.createElement('span'))"],
	['text elsewhere changes', "document.getElementById('elsewhere').textContent = 'Other text'"],
	['an attribute elsewhere changes', "document.getElementById('elsewhere').setAttribute('class', 'hovered')"],
	['an attribute beside it changes', "document.getElementById('beside').setAttribute('style', 'outline-color: red')"],
	['another copy marks its block', "const note = document.getElementById('note'); note.setAttribute('data-tfold-hidden', `${note.getAttribute('data-tfold-hidden')} other`)"],
	[
		'another copy starts a morph',
		"const layer = document.createElement('tfold-ghosts'); layer.innerHTML = '<style>#elsewhere { outline: none; }</style>'; document.documentElement.append(layer); await new Promise((resolve) => { layer.firstChild.onload = resolve; })",
	],
	[
		'an image loads beside it',
		"const image = new Image(); image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; document.getElementById('beside').append(image); await new Promise((resolve) => { image.onload = resolve; })",
	],
])('a fold reads and writes nothing when %s', async (_, change) => {
	const page = await foldedPage();
	expect(await afterChange(page, change)).toEqual({ reads: { styles: 0, values: 0 }, overlayWrites: 0 });
	await page.close();
});

test('an attribute around a fold that moves nothing reads a few values and writes nothing, far short of a whole look', async () => {
	const page = await foldedPage();
	const seen = await afterChange(page, touchWrapper);
	expect(seen.overlayWrites).toBe(0);
	expect(seen.reads.values).toBeGreaterThan(0);
	expect(seen.reads.values).toBeLessThan(61);
	await page.close();
});

test('a theme class on an element around a fold lands before the next frame is drawn', async () => {
	const page = await foldedPage();
	const before = await foldInk(page);
	await page.evaluate(inFrames("document.getElementById('wrapper').classList.add('night')", 1));
	expect({ before, firstFrame: await foldInk(page) }).toEqual({ before: 'rgb(34, 34, 34)', firstFrame: 'rgb(238, 238, 238)' });
	await page.close();
});

test('a theme that moves only the color of a word a Brief copied reaches the copy', async () => {
	const page = await foldedPage(`<style>#note { background-color: #fff4c2; color: #222; } a { color: rgb(0, 0, 200); } .accent a { color: rgb(200, 0, 0); }</style>
<div id="wrapper"><p id="note">A note with <a href="#x">one link</a> long enough to fold in it. It has two sentences so a fold of it keeps some words.</p></div>`, 1);
	const linkInk = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-tfold-overlay] a') as Element).color);
	expect(await linkInk()).toBe('rgb(0, 0, 200)');
	await page.evaluate(inFrames("document.getElementById('wrapper').classList.add('accent')", 1));
	expect(await linkInk()).toBe('rgb(200, 0, 0)');
	await page.close();
});

test('changes around a fold on frame after frame read it at the longest wait, and the last one lands in the first frame after they stop', async () => {
	const page = await foldedPage();
	const once = await afterChange(page, touchWrapper);
	const stream = await page.evaluate(async () => {
		const { reads } = globalThis as unknown as Seen;
		const wrapper = document.getElementById('wrapper') as HTMLElement;
		const started = performance.now();
		const before = reads.values;
		let frames = 0;
		while (performance.now() - started < 1000) {
			wrapper.style.transform = `translateY(${frames++ % 2}px)`;
			await new Promise(requestAnimationFrame);
		}
		const values = reads.values - before;
		wrapper.classList.add('night');
		await new Promise(requestAnimationFrame);
		await new Promise(requestAnimationFrame);
		return { values, frames };
	});
	expect(stream.frames).toBeGreaterThan(20);
	expect(stream.values).toBeLessThanOrEqual(6 * once.reads.values);
	expect(await foldInk(page)).toBe('rgb(238, 238, 238)');
	await page.close();
});

test('a fold takes a theme at the longest wait even while the page never stops writing around it', async () => {
	const page = await foldedPage();
	const waited = await page.evaluate(async () => {
		const wrapper = document.getElementById('wrapper') as HTMLElement;
		const ink = () => getComputedStyle(document.querySelector('[data-tfold-overlay]') as Element).webkitTextFillColor;
		let frames = 0;
		const frame = async () => {
			wrapper.style.transform = `translateY(${frames++ % 2}px)`;
			await new Promise(requestAnimationFrame);
		};
		for (let i = 0; i < 10; i++) await frame();
		wrapper.classList.add('night');
		const started = performance.now();
		while (ink() !== 'rgb(238, 238, 238)' && performance.now() - started < 2000) await frame();
		return performance.now() - started;
	});
	expect(waited).toBeLessThan(400);
	await page.close();
});

test.each<[string, string]>([
	['text', "document.getElementById('note').firstChild.data = 'A note long enough to fold, with new words '"],
	['a child', "document.getElementById('note').append(document.createElement('span'))"],
	['an attribute', "document.querySelector('#note a').className = 'marked'"],
	['the attribute of the block', "document.getElementById('note').className = 'marked'"],
])('a change of %s inside a block draws its fold again in the first frame', async (_, change) => {
	const page = await foldedPage(notePage, 1);
	expect((await afterChange(page, change, 1)).reads.values).toBeGreaterThanOrEqual(61);
	await page.close();
});

test.each<[string, string]>([
	['added', "document.head.insertAdjacentHTML('beforeend', '<style>#note { color: rgb(1, 2, 3) !important; }</style>')"],
	['added inside a wrapper', "document.getElementById('elsewhere').insertAdjacentHTML('beforeend', '<div><style>#note { color: rgb(1, 2, 3) !important; }</style></div>')"],
	['edited', "document.querySelector('style').append('#note { color: rgb(1, 2, 3) !important; }')"],
	['rewritten', "document.querySelector('style').firstChild.data += '#note { color: rgb(1, 2, 3) !important; }'"],
])('a style sheet %s reaches a fold', async (_, change) => {
	const page = await foldedPage();
	await page.evaluate(change);
	await expect.poll(() => foldInk(page)).toBe('rgb(1, 2, 3)');
	await page.close();
});

test('a style sheet switched by its media attribute, or removed, reaches a fold', async () => {
	const page = await foldedPage();
	await page.evaluate(() => {
		document.head.insertAdjacentHTML('beforeend', '<style id="extra" media="not all">#note { color: rgb(1, 2, 3) !important; }</style>');
	});
	await expect.poll(() => foldInk(page)).toBe('rgb(34, 34, 34)');
	await page.evaluate(() => document.getElementById('extra')?.setAttribute('media', 'all'));
	await expect.poll(() => foldInk(page)).toBe('rgb(1, 2, 3)');
	await page.evaluate(() => document.getElementById('extra')?.remove());
	await expect.poll(() => foldInk(page)).toBe('rgb(34, 34, 34)');
	await page.close();
});

test('a style sheet taken out with the element around it reaches a fold', async () => {
	const page = await foldedPage();
	await page.evaluate(() => {
		document.body.insertAdjacentHTML('beforeend', '<div id="extra"><style>#note { color: rgb(1, 2, 3) !important; }</style></div>');
	});
	await expect.poll(() => foldInk(page)).toBe('rgb(1, 2, 3)');
	await page.evaluate(() => document.getElementById('extra')?.remove());
	await expect.poll(() => foldInk(page)).toBe('rgb(34, 34, 34)');
	await page.close();
});

test('a style sheet in a link reaches a fold when it loads, after its element went in', async () => {
	const page = await foldedPage();
	await page.route('**/late.css', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 200));
		await route.fulfill({ contentType: 'text/css', body: '#note { color: rgb(1, 2, 3) !important; }' });
	});
	await page.evaluate(() => {
		document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'http://tfold.test/late.css' }));
	});
	await expect.poll(() => foldInk(page)).toBe('rgb(1, 2, 3)');
	await page.close();
});

test('a rule of the window size reaches a fold when the window changes', async () => {
	const page = await foldedPage(`<style>#note { background: #fff4c2; font-size: 20px; } @media (max-width: 600px) { #note { font-size: 12px; } }</style>
<p id="note">A note long enough to fold, with words in it. It has two sentences so a fold of it keeps some words.</p>`);
	await page.setViewportSize({ width: 500, height: 600 });
	await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('[data-tfold-overlay]') as Element).fontSize)).toBe('12px');
	await page.close();
});

test('a fold whose wrapper moves under a themed element takes the look it has there', async () => {
	const page = await foldedPage();
	await page.evaluate(() => {
		document.body.insertAdjacentHTML('beforeend', '<div id="dark" class="night"></div>');
		document.getElementById('dark')?.append(document.getElementById('wrapper') as Element);
	});
	await expect.poll(() => foldInk(page)).toBe('rgb(238, 238, 238)');
	await page.close();
});

test.each<[string, string]>([
	['takes its overlay away', "document.querySelector('[data-tfold-overlay]').remove()"],
	['puts an element between the block and its overlay', "document.getElementById('note').after(document.createElement('div'))"],
	['takes its mark away', "document.getElementById('note').removeAttribute('data-tfold-hidden')"],
	["takes this script's style away", "[...document.querySelectorAll('style')].filter((style) => style.textContent.includes('data-tfold-hidden')).forEach((style) => style.remove())"],
])('a page that %s gets the fold back in the first frame', async (_, change) => {
	const page = await foldedPage();
	await page.evaluate(inFrames(change, 1));
	const shown = await page.evaluate(() => {
		const [block, overlay] = [document.getElementById('note') as Element, document.querySelector('[data-tfold-overlay]')];
		return { hidden: !block.checkVisibility(), overlay: overlay?.checkVisibility(), follows: block.nextElementSibling === overlay };
	});
	expect(shown).toEqual({ hidden: true, overlay: true, follows: true });
	await page.close();
});

const noted = (css: string) => `<style>#note { background-color: #fff4c2; } .turned { color: rgb(9, 9, 9); } ${css}</style>
<div id="wrapper"><p id="note">A note long enough to fold, with words in it. It has two sentences so a fold of it keeps some words.</p></div>`;

test.each<[string, string, string]>([
	['that cannot move a color', '@keyframes moves { from { transform: translateX(0); opacity: 0.5; background-position: 0 0; } to { transform: translateX(1px); opacity: 1; background-position: 9px 0; } }', "document.getElementById('wrapper').style.animation = 'moves 5s'"],
	['of a transition that cannot move a color', '#wrapper { transition: transform 5s; }', "document.getElementById('wrapper').style.transform = 'translateX(4px)'"],
	['a script runs, since a document never sees its end', '', "document.getElementById('wrapper').animate({ color: ['#000', '#fff'] }, 5000)"],
	['that has stopped and holds its last frame', '@keyframes tints { from { color: #000; } to { color: #010101; } }', "document.getElementById('wrapper').style.animation = 'tints 1ms forwards'"],
])('a fold over a background of its own holds one reading through an animation %s', async (_, css, start) => {
	const page = await foldedPage(noted(css));
	await page.evaluate(inFrames(start, 5));
	await page.evaluate(inFrames("document.getElementById('wrapper').setAttribute('data-touched', '')", 3));
	expect(await foldStyle(page)).not.toContain('currentcolor');
	await page.close();
});

test.each<[string, string, string]>([
	['transition', '#wrapper { transition: color 400ms; }', "document.getElementById('wrapper').classList.add('turned')"],
	['keyframe animation', '@keyframes tints { from { color: #000; } to { color: #eee; } }', "document.getElementById('wrapper').style.animation = 'tints 400ms'"],
])('a fold over a background of its own follows a %s of a color around it, then holds one reading again', async (_, css, start) => {
	const page = await foldedPage(noted(css));
	await page.evaluate(inFrames(start, 3));
	const during = await foldStyle(page);
	await expect.poll(() => foldStyle(page)).not.toContain('currentcolor');
	expect(during).toContain('currentcolor');
	await page.close();
});

test('an animation that stops around a fold and moved nothing writes nothing', async () => {
	const page = await foldedPage(noted('@keyframes moves { from { opacity: 0.5; } to { opacity: 1; } }'));
	const seen = await afterChange(
		page,
		"const wrapper = document.getElementById('wrapper'); wrapper.style.animation = 'moves 50ms'; await new Promise((resolve) => wrapper.addEventListener('animationend', resolve))",
	);
	expect(seen.overlayWrites).toBe(0);
	await page.close();
});
