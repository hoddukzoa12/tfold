import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../e2e/fixture-server.ts';
import { defaultShortcuts } from '../shortcuts.ts';

type BlockState = { id: string; level: number };
type Hook = {
	readBlocks(): BlockState[];
	setLevel(id: string, level: number): void;
	blockAt(node: Node): BlockState | undefined;
};
type Tf = { __tfold: Hook };

const wikiParagraphs = '#mw-content-text section > p:not(.mw-empty-elt):not([data-tfold-overlay])';
const twelveWords = 'This sentence has exactly twelve words so it counts as a block.';

let browser: Browser;
let server: FixtureServer;
let contentScript: string;

const noExtension = `globalThis.chrome = { runtime: { sendMessage: (message) => message.type === 'page' ? Promise.resolve(${JSON.stringify({ on: true, hint: false, shortcuts: defaultShortcuts })}) : Promise.reject(new Error('no extension')), onMessage: { addListener() {} } }, i18n: { getUILanguage: () => 'en' }, storage: { sync: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } } };\n`;

beforeAll(async () => {
	const bundle = build({
		entryPoints: [path.join(import.meta.dirname, 'index.ts')],
		bundle: true,
		format: 'iife',
		target: 'chrome120',
		define: { TFOLD_EDITION: '"store"', TFOLD_DEV: 'false' },
		write: false,
	});
	[browser, server, contentScript] = await Promise.all([
		chromium.launch(),
		startFixtureServer(),
		bundle.then((result) => noExtension + (result.outputFiles[0]?.text ?? '')),
	]);
});

afterAll(async () => {
	await browser.close();
	await server.close();
});

async function open(fixture: string, ready = 'body'): Promise<Page> {
	const page = await browser.newPage();
	await page.goto(new URL(fixture, server.baseURL).href, { waitUntil: 'load' });
	await page.locator(ready).first().waitFor({ state: 'attached' });
	await page.addScriptTag({ content: contentScript });
	return page;
}

async function openHtml(html: string): Promise<Page> {
	const page = await browser.newPage();
	await page.setContent(html);
	await page.addScriptTag({ content: contentScript });
	return page;
}

const nextFrame = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));

async function levelsAt(page: Page, selectors: Record<string, string>): Promise<Record<string, number | null>> {
	return page.evaluate((entries) => {
		const tf = (globalThis as unknown as Tf).__tfold;
		return Object.fromEntries(
			Object.entries(entries).map(([name, selector]) => {
				const el = document.querySelector(selector);
				if (!el) throw new Error(`no element matches ${selector}`);
				return [name, tf.blockAt(el)?.level ?? null];
			}),
		);
	}, selectors);
}

const blockCount = (page: Page) => page.evaluate(() => (globalThis as unknown as Tf).__tfold.readBlocks().length);

function longItem(page: Page, list: string): Promise<string> {
	return page.evaluate((list) => {
		const items = [...document.querySelectorAll(`${list} li`)];
		const index = items.findIndex((li) => (li.textContent ?? '').trim().split(/\s+/).length >= 25);
		if (index < 0) throw new Error(`no long item in ${list}`);
		items[index]?.setAttribute('data-long-item', list);
		return `[data-long-item="${list}"]`;
	}, list);
}

test('Wikipedia: paragraphs are blocks, and references, short paragraphs, captions and navigation are not', async () => {
	const page = await open('/wikipedia-black-hole/');
	expect(await levelsAt(page, {
		lead: wikiParagraphs,
		reference: await longItem(page, 'ol.references'),
		emptyParagraph: '#mw-content-text p.mw-empty-elt',
		caption: '#mw-content-text figure figcaption',
		navItem: 'nav li',
	})).toEqual({ lead: 0, reference: null, emptyParagraph: null, caption: null, navItem: null });
	expect(await blockCount(page)).toBeGreaterThan(50);
	await page.close();
});

test('a short line beside a long paragraph is a block, and one word, a link item, a short div, text on a video, a caption and a cell are not', async () => {
	const page = await openHtml(
		`<main style="width: 600px"><p id="prose">${twelveWords}</p><p id="line">For this game:</p><p id="word">Note.</p><ul><li id="link"><a href="#a">The harbor rules page</a></li><li id="mixed"><a href="#b">Charts</a> of the tide at each harbor</li></ul>` +
			'<div id="div">A short div here.</div><div style="position: relative"><video></video><p id="subtitle" style="position: absolute">We tied up at the north end.</p></div>' +
			'<img alt="" width="10" height="10" /><p id="caption">The boatbuilder and his yard.</p><div style="display: grid; grid-template-columns: 1fr 1fr 1fr"><p id="cell">A short cell.</p></div></main>',
	);
	expect(await levelsAt(page, { line: '#line', word: '#word', link: '#link', mixed: '#mixed', div: '#div', subtitle: '#subtitle', caption: '#caption', cell: '#cell' })).toEqual({
		line: 0,
		word: null,
		link: null,
		mixed: 0,
		div: null,
		subtitle: null,
		caption: null,
		cell: null,
	});
	await page.close();
});

test('a page of only short lines has no block', async () => {
	const page = await openHtml('<main><p id="line">For this game:</p><p id="other">And here another short line.</p></main>');
	expect(await levelsAt(page, { line: '#line', other: '#other' })).toEqual({ line: null, other: null });
	await page.close();
});

test('Korean Wikipedia: footnotes and the bibliography are not blocks', async () => {
	const page = await open('/wikipedia-ko-black-hole/');
	expect(await levelsAt(page, {
		lead: wikiParagraphs,
		footnote: await longItem(page, 'ol.references'),
		bibliography: await longItem(page, '.refbegin'),
	})).toEqual({ lead: 0, footnote: null, bibliography: null });
	await page.close();
});

test('list items under a heading that names references are not blocks, at any depth below it', async () => {
	const item = (id: string) => `<li id="${id}">Item ${id} is a long list entry of more than twelve words, as a citation would be.</li>`;
	const page = await openHtml(
		`<main><h2>Background</h2><p id="p">${twelveWords}</p><ul>${item('plain')}</ul>` +
			`<h2>References</h2><h3>Primary</h3><ul>${item('nested')}</ul>` +
			`<h2>참고 문헌</h2><ul>${item('korean')}</ul><h2>See also</h2><ul>${item('after')}</ul></main>`,
	);
	expect(await levelsAt(page, { p: '#p', plain: '#plain', nested: '#nested', korean: '#korean', after: '#after' })).toEqual({
		p: 0,
		plain: 0,
		nested: null,
		korean: null,
		after: 0,
	});
	await page.close();
});

test('arXiv: the paragraph with inline formulas is a block, and figure captions are not', async () => {
	const page = await open('/arxiv-2401.04088/');
	expect(await levelsAt(page, {
		formulas: '[id="S2.SS1.p1.1"]',
		abstract: '.ltx_abstract p',
		caption: 'figure figcaption',
	})).toEqual({ formulas: 0, abstract: 0, caption: null });
	expect(await blockCount(page)).toBeGreaterThan(30);
	await page.close();
});

test('React: the three paragraphs are the only blocks', async () => {
	const page = await open('/react/', '#counter');
	expect(await blockCount(page)).toBe(3);
	expect(await levelsAt(page, { counter: '#counter-paragraph', heading: 'h1', nav: 'nav' })).toEqual({
		counter: 0,
		heading: null,
		nav: null,
	});
	await page.close();
});

test('setLevel steps a paragraph through Brief, Key and Takeaway, and Full restores its outerHTML', async () => {
	const page = await open('/wikipedia-black-hole/');
	const result = await page.evaluate((selector) => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const paragraph = document.querySelectorAll(selector)[1];
		if (!paragraph) throw new Error('no second paragraph');
		const before = paragraph.outerHTML;
		const block = tf.blockAt(paragraph);
		if (!block) throw new Error('the second paragraph is not a block');
		const seen = [1, 2, 3, 0].map((level) => {
			tf.setLevel(block.id, level);
			const next = paragraph.nextElementSibling;
			return {
				level: tf.readBlocks().find((state) => state.id === block.id)?.level,
				originalShown: paragraph.checkVisibility(),
				overlay: next?.hasAttribute('data-tfold-overlay') ? next.textContent : null,
			};
		});
		return { seen, restored: paragraph.outerHTML === before };
	}, wikiParagraphs);
	const brief = 'Objects whose gravitational fields are too strong for light to escape were first considered in the 18th century.';
	expect(result).toEqual({
		seen: [
			{ level: 1, originalShown: false, overlay: brief },
			{ level: 2, originalShown: false, overlay: brief },
			{
				level: 3,
				originalShown: false,
				overlay: 'Objects whose gravitational fields are too strong for light to escape were first considered…',
			},
			{ level: 0, originalShown: true, overlay: null },
		],
		restored: true,
	});
	await page.close();
});

for (const [name, fixture, ready] of [
	['Wikipedia', '/wikipedia-black-hole/', 'body'],
	['arXiv', '/arxiv-2401.04088/', 'body'],
	['React', '/react/', '#counter'],
] as const) {
	test(`${name}: folding every block and unfolding it again restores the body's outerHTML`, async () => {
		const page = await open(fixture, ready);
		const result = await page.evaluate(() => {
			const tf = (globalThis as unknown as Tf).__tfold;
			const before = document.body.outerHTML;
			const ids = tf.readBlocks().map((block) => block.id);
			for (const id of ids) tf.setLevel(id, 1);
			const overlays = document.querySelectorAll('[data-tfold-overlay]').length;
			for (const id of ids) tf.setLevel(id, 3);
			for (const id of ids) tf.setLevel(id, 0);
			Object.assign(globalThis, { bodyBefore: before });
			return {
				blocks: ids.length,
				overlays,
				left: document.querySelectorAll('[data-tfold-overlay], [data-tfold-hidden]').length,
			};
		});
		await page.waitForFunction(() => document.querySelector('tfold-ghosts, tfold-gap') === null);
		const restored = await page.evaluate(() => document.body.outerHTML === (globalThis as unknown as { bodyBefore: string }).bodyBefore);
		expect(result.blocks).toBeGreaterThan(0);
		expect({ ...result, restored }).toEqual({ blocks: result.blocks, overlays: result.blocks, left: 0, restored: true });
		await page.close();
	}, 120_000);
}

test('two paragraphs with the same text get their own ids and levels', async () => {
	const page = await openHtml(`<main><p id="a">${twelveWords}</p><p id="b">${twelveWords}</p></main>`);
	const result = await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [a, b] = tf.readBlocks();
		if (!a || !b) throw new Error('expected two blocks');
		tf.setLevel(a.id, 2);
		return {
			distinct: a.id !== b.id,
			levels: tf.readBlocks().map((block) => block.level),
			bShown: document.querySelector('#b')?.checkVisibility(),
		};
	});
	expect(result).toEqual({ distinct: true, levels: [2, 0], bShown: true });
	await page.close();
});

test('a folded paragraph that the page removes and renders again comes back at its level', async () => {
	const article = `<article><p>${twelveWords}</p><p>A second paragraph that stays at Full the whole time, with twelve words or more.</p></article>`;
	const page = await openHtml(`<main>${article}</main>`);
	const id = await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [first] = tf.readBlocks();
		if (!first) throw new Error('no block');
		tf.setLevel(first.id, 2);
		document.querySelector('article')?.remove();
		return first.id;
	});
	await nextFrame(page);
	await page.evaluate((html) => document.querySelector('main')?.insertAdjacentHTML('beforeend', html), article);
	await nextFrame(page);
	const result = await page.evaluate(() => {
		const first = document.querySelector('article p');
		const shown = {
			hidden: first?.hasAttribute('data-tfold-hidden'),
			overlayLevel: first?.nextElementSibling?.getAttribute('data-tf-level'),
		};
		return { ...shown, blocks: (globalThis as unknown as Tf).__tfold.readBlocks() };
	});
	expect(result).toEqual({
		hidden: true,
		overlayLevel: '2',
		blocks: [{ id, level: 2 }, { id: expect.any(String) as string, level: 0 }],
	});
	await page.close();
});

test('a change to a hidden original renders again in its overlay', async () => {
	const page = await openHtml('<main><p>The counter in this paragraph reads <b id="n">0</b> right now, and the page may change it.</p></main>');
	await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [block] = tf.readBlocks();
		if (!block) throw new Error('no block');
		tf.setLevel(block.id, 1);
		const counter = document.querySelector('#n');
		if (counter) counter.textContent = '7';
	});
	await nextFrame(page);
	expect(await page.locator('[data-tfold-overlay]').textContent()).toBe(
		'The counter in this paragraph reads 7 right now, and the page may change it.',
	);
	await page.close();
});

test('a folded paragraph that the page copies with innerHTML comes back as one tracked fold', async () => {
	const page = await openHtml(`<main><article><p>${twelveWords}</p></article></main>`);
	const id = await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [block] = tf.readBlocks();
		if (!block) throw new Error('no block');
		tf.setLevel(block.id, 2);
		const article = document.querySelector('article');
		const copy = article?.innerHTML ?? '';
		if (article) article.innerHTML = copy;
		return block.id;
	});
	await nextFrame(page);
	const result = await page.evaluate(() => {
		const paragraph = document.querySelector('article p');
		const shown = {
			overlays: document.querySelectorAll('[data-tfold-overlay]').length,
			hidden: paragraph?.hasAttribute('data-tfold-hidden'),
			overlayFollows: paragraph?.nextElementSibling?.getAttribute('data-tf-level'),
		};
		return { ...shown, blocks: (globalThis as unknown as Tf).__tfold.readBlocks() };
	});
	expect(result).toEqual({ overlays: 1, hidden: true, overlayFollows: '2', blocks: [{ id, level: 2 }] });
	await page.close();
});

test('a page that copies its markup in the middle of a morph keeps the fold and leaves no gap behind', async () => {
	const article = `<article><p>${twelveWords}</p><p>A second paragraph that stays at Full the whole time, with twelve words or more.</p></article>`;
	const page = await openHtml(`<main>${article}</main>`);
	const id = await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [first] = tf.readBlocks();
		if (!first) throw new Error('no block');
		tf.setLevel(first.id, 2);
		return first.id;
	});
	await page.waitForFunction(() => document.querySelector('tfold-gap') !== null);
	const copiedGap = await page.evaluate(() => {
		const article = document.querySelector('article');
		const gap = document.querySelector('tfold-gap') !== null;
		const copy = article?.innerHTML ?? '';
		if (article) article.innerHTML = copy;
		return gap;
	});
	await page.waitForFunction(() => document.querySelector('tfold-ghosts, tfold-gap') === null);
	const result = await page.evaluate(() => ({
		overlays: document.querySelectorAll('[data-tfold-overlay]').length,
		blocks: (globalThis as unknown as Tf).__tfold.readBlocks(),
	}));
	expect(copiedGap).toBe(true);
	expect(result).toEqual({ overlays: 1, blocks: [{ id, level: 2 }, { id: expect.any(String) as string, level: 0 }] });
	await page.close();
});

test('a page with no article or main uses every paragraph, even when a long list item exists', async () => {
	const page = await openHtml(
		`<div><p id="prose">${twelveWords}</p><ul><li>A list item that is long enough, with twelve words or more in it.</li></ul></div>`,
	);
	expect(await levelsAt(page, { prose: '#prose', item: 'li' })).toEqual({ prose: 0, item: 0 });
	await page.close();
});

test('a line break between two sentences splits them', async () => {
	const page = await openHtml(
		'<main><p>The first sentence ends here.<br>The second sentence follows it with enough words to count.</p></main>',
	);
	await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [block] = tf.readBlocks();
		if (!block) throw new Error('no block');
		tf.setLevel(block.id, 1);
	});
	expect(await page.locator('[data-tfold-overlay]').textContent()).toBe('The first sentence ends here.');
	await page.close();
});

test('text the page hides stays out of the fold, also after the page changes the folded original', async () => {
	const page = await openHtml(
		'<main><p><span hidden>A hidden lead sentence.</span> The visible lead has <b id="n">0</b> items <span style="display:none">and a hidden clause</span> and more than enough words to count.</p></main>',
	);
	const overlay = page.locator('[data-tfold-overlay]');
	await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [block] = tf.readBlocks();
		if (!block) throw new Error('no block');
		tf.setLevel(block.id, 1);
	});
	expect(await overlay.innerText()).toBe('The visible lead has 0 items and more than enough words to count.');
	await page.evaluate(() => {
		const counter = document.querySelector('#n');
		if (counter) counter.textContent = '7';
	});
	await nextFrame(page);
	expect(await overlay.innerText()).toBe('The visible lead has 7 items and more than enough words to count.');
	await page.close();
});

test('a folded ordered-list item keeps its value', async () => {
	const page = await openHtml(
		'<main><ol><li value="10">A numbered item that starts the list at ten, with twelve words or more.</li></ol></main>',
	);
	await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [block] = tf.readBlocks();
		if (!block) throw new Error('no block');
		tf.setLevel(block.id, 1);
	});
	expect(await page.locator('li[data-tfold-overlay]').evaluate((li) => (li as HTMLLIElement).value)).toBe(10);
	await page.close();
});

test('a page that reuses a folded paragraph for other text shows that text in full, and the fold comes back with its own text', async () => {
	const first = 'The first post in this list is long enough to count as a block of its own.';
	const second = 'A different post now fills the same element after the list scrolls past the first one.';
	const page = await openHtml(`<main><p id="slot">${first}</p></main>`);
	const id = await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [block] = tf.readBlocks();
		if (!block) throw new Error('no block');
		tf.setLevel(block.id, 2);
		return block.id;
	});
	await nextFrame(page);
	const showing = (text: string) =>
		page.evaluate((text) => {
			const slot = document.querySelector('#slot');
			if (slot) slot.textContent = text;
		}, text);
	const state = () =>
		page.evaluate(() => ({
			shown: document.querySelector('#slot')?.checkVisibility(),
			overlayLevel: document.querySelector('#slot + [data-tfold-overlay]')?.getAttribute('data-tf-level') ?? null,
			blocks: (globalThis as unknown as Tf).__tfold.readBlocks(),
		}));
	await showing(second);
	await nextFrame(page);
	const other = await state();
	await showing(first);
	await nextFrame(page);
	const back = await state();
	expect(other).toEqual({ shown: true, overlayLevel: null, blocks: [{ id: expect.any(String) as string, level: 0 }] });
	expect(other.blocks[0]?.id).not.toBe(id);
	expect(back).toEqual({ shown: false, overlayLevel: '2', blocks: [{ id, level: 2 }] });
	await page.close();
});

test('a folded paragraph that the page renders again with a space where its line break was comes back at its level', async () => {
	const opening = 'The opening sentence of this post is long enough to read on its own.';
	const closing = 'The closing sentence sits on the next line until the page renders it again.';
	const page = await openHtml(`<main><p id="post">${opening}<br>${closing}</p></main>`);
	const id = await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [block] = tf.readBlocks();
		if (!block) throw new Error('no block');
		tf.setLevel(block.id, 2);
		return block.id;
	});
	await nextFrame(page);
	await page.evaluate((text) => {
		const again = document.createElement('p');
		again.id = 'post';
		again.textContent = text;
		document.querySelector('#post')?.replaceWith(again);
	}, `${opening} ${closing}`);
	await nextFrame(page);
	const shown = await page.evaluate(() => ({
		hidden: document.querySelector('#post')?.hasAttribute('data-tfold-hidden'),
		overlayLevel: document.querySelector('#post + [data-tfold-overlay]')?.getAttribute('data-tf-level') ?? null,
	}));
	expect(shown).toEqual({ hidden: true, overlayLevel: '2' });
	expect(await page.evaluate(() => (globalThis as unknown as Tf).__tfold.readBlocks())).toEqual([{ id, level: 2 }]);
	await page.close();
});

test('the fold shortcut folds the new text of an element the page reused under a still pointer', async () => {
	const first = 'The first post in this list is long enough to count as a block of its own.';
	const second = 'A different post now fills the same element after the list scrolls past the first one.';
	const page = await openHtml(`<main><p id="slot">${first}</p></main>`);
	const box = await page.locator('#slot').boundingBox();
	if (!box) throw new Error('no box for #slot');
	await page.mouse.move(box.x + 10, box.y + 5);
	await page.keyboard.press('Alt+Shift+ArrowDown');
	await nextFrame(page);
	const [folded] = await page.evaluate(() => (globalThis as unknown as Tf).__tfold.readBlocks());
	await page.evaluate((text) => {
		const slot = document.querySelector('#slot');
		if (slot) slot.textContent = text;
	}, second);
	await nextFrame(page);
	await page.keyboard.press('Alt+Shift+ArrowDown');
	await nextFrame(page);
	const blocks = await page.evaluate(() => (globalThis as unknown as Tf).__tfold.readBlocks());
	expect(folded?.level).toBe(1);
	expect(blocks).toEqual([{ id: expect.any(String) as string, level: 1 }]);
	expect(blocks[0]?.id).not.toBe(folded?.id);
	await page.close();
});

test('on a page with no paragraph in its article, text divs are blocks, and navigation, buttons, menus, toolbars, editable text and hidden text are not', async () => {
	const long = (what: string) => `This ${what} holds enough words in a row to count as a paragraph. It has a second sentence too.`;
	const page = await openHtml(
		`<main><article><div id="plain">${long('div')} It has <a href="#x">a link</a> and <em>emphasis</em>.</div>` +
			`<section id="section"><span>${long('section')}</span></section>` +
			`<div id="wrapper"><div id="inner">${long('inner div')}</div></div>` +
			`<div id="outer"><span>${long('outer div')} </span><span><div id="deep">${long('deep div')}</div></span></div>` +
			`<nav><div id="nav">${long('navigation')}</div></nav>` +
			`<div role="navigation"><div id="roleNav">${long('navigation box')}</div></div>` +
			`<button type="button"><div id="button">${long('button')}</div></button>` +
			`<div role="button"><div id="roleButton">${long('card')}</div></div>` +
			`<div role="menu"><div role="menuitem" id="menu">${long('menu item')}</div></div>` +
			`<div role="toolbar"><div id="toolbar">${long('toolbar')}</div></div>` +
			`<div aria-hidden="true"><div id="ariaHidden">${long('decoration')}</div></div>` +
			`<div contenteditable="true"><div id="editable">${long('draft')}</div></div>` +
			`<div id="short">Too short to count.</div></article></main>`,
	);
	const names = ['plain', 'section', 'wrapper', 'inner', 'nav', 'roleNav', 'button', 'roleButton', 'menu', 'toolbar', 'ariaHidden', 'editable', 'short'];
	expect(await levelsAt(page, Object.fromEntries(names.map((name) => [name, `#${name}`])))).toEqual({
		plain: 0,
		section: 0,
		wrapper: null,
		inner: 0,
		nav: null,
		roleNav: null,
		button: null,
		roleButton: null,
		menu: null,
		toolbar: null,
		ariaHidden: null,
		editable: null,
		short: null,
	});
	expect(await blockCount(page)).toBe(4);
	await page.close();
});

test('on a page with no <p>, a text div is a block only when it reads as prose outside widgets, dialogs, tables and banners pinned to the window', async () => {
	const two = (what: string) => `This ${what} opens with a sentence of several plain words. A second sentence follows it.`;
	const roles = ['radio', 'checkbox', 'switch', 'menuitemradio', 'tooltip', 'alertdialog', 'status', 'slider', 'treegrid'];
	const page = await openHtml(
		`<div id="prose">${two('paragraph')}</div>` +
			'<div id="long">One sentence that runs on for more than twenty five words reads as a paragraph, even though it never stops once along the whole of its way</div>' +
			'<div id="oneSentence">One sentence of fifteen words or so reads as a label rather than a paragraph.</div>' +
			'<div id="initialisms">Doors open at 9:41 a.m. Eastern time and close at 6:15 p.m. Eastern time on weekdays.</div>' +
			'<div id="dates">Posted <time>November 2, 2026</time>. Updated <time>November 3, 2026</time>. Seven minutes to read in full.</div>' +
			roles.map((role) => `<div role="${role}"><div id="${role}">${two(role)}</div></div>`).join('') +
			`<table><tr><td><div id="cell">${two('table cell')}</div></td></tr></table>` +
			`<div style="position: sticky; top: 0"><div id="sticky">${two('sticky bar')}</div></div>` +
			`<div style="position: fixed; bottom: 0"><div id="fixed">${two('fixed banner')}</div></div>`,
	);
	const names = ['prose', 'long', 'oneSentence', 'initialisms', 'dates', ...roles, 'cell', 'sticky', 'fixed'];
	expect(await levelsAt(page, Object.fromEntries(names.map((name) => [name, `#${name}`])))).toEqual({
		prose: 0,
		long: 0,
		oneSentence: null,
		initialisms: null,
		dates: null,
		...Object.fromEntries(roles.map((role) => [role, null])),
		cell: null,
		sticky: null,
		fixed: null,
	});
	await page.close();
});

test('on a page with no <p>, a box fixed to the window keeps its text out unless it fills the window and scrolls the text in a pane inside it', async () => {
	const two = (what: string) => `This ${what} opens with a sentence of several plain words. A second sentence follows it.`;
	const page = await openHtml(
		`<div style="position: fixed; left: 0; right: 0; bottom: 0; max-height: 90%; overflow-y: auto"><div id="scrollingBanner">${two('scrolling banner')}</div></div>` +
			`<div style="position: fixed; left: 0; right: 0; bottom: 120px"><div style="max-height: 4.5em; overflow-y: auto"><div id="bannerPane">${two('banner pane')}</div></div></div>` +
			`<div style="position: fixed; top: 0; right: 0; width: 240px; height: 60px; overflow-y: auto"><div id="panel">${two('panel')}</div></div>` +
			`<div style="position: fixed; inset: 0; overflow-y: auto"><div style="max-width: 30em; margin: 80px auto"><div id="popup">${two('popup')}</div></div></div>` +
			'<div style="position: fixed; inset: 0; display: grid; grid-template-columns: 200px 1fr"><div></div>' +
			`<div style="overflow-y: auto"><div id="message">${two('message')}</div></div></div>`,
	);
	expect(
		await levelsAt(page, { scrollingBanner: '#scrollingBanner', bannerPane: '#bannerPane', panel: '#panel', popup: '#popup', message: '#message' }),
	).toEqual({ scrollingBanner: null, bannerPane: null, panel: null, popup: null, message: 0 });
	await page.close();
});

test('a page that writes its article in paragraphs keeps its text divs out', async () => {
	const page = await openHtml(
		`<main><p id="p">${twelveWords}</p><div id="caption">A caption under a photo that runs long enough to count as a paragraph of text.</div></main>`,
	);
	expect(await levelsAt(page, { p: '#p', caption: '#caption' })).toEqual({ p: 0, caption: null });
	await page.close();
});

test('the text of an X post is one block with its mention div inside it, on a page with paragraphs too', async () => {
	const page = await openHtml(
		`<main><p id="p">${twelveWords}</p><article><div><div data-testid="tweetText" id="post" lang="en" dir="auto">` +
			'<span>Repotted the basil this morning with </span><div><span><a href="/someone">@someone</a></span></div>' +
			'<span> and the windowsill herbs finally have room to grow before the weekend.</span></div></div></article></main>',
	);
	expect(await levelsAt(page, { post: '#post', mention: '#post a', p: '#p' })).toEqual({ post: 0, mention: 0, p: 0 });
	expect(await blockCount(page)).toBe(2);
	await page.close();
});
