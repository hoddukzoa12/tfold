import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../e2e/fixture-server.ts';
import type { FoldRequest } from '../fold/prompt.ts';

type Tf = { __tfold: { readBlocks(): { id: string }[]; setLevel(id: string, level: number): void } };

let browser: Browser;
let server: FixtureServer;
let contentScript: string;
let internals: string;

const bundle = (options: Parameters<typeof build>[0]) =>
	build({ ...options, bundle: true, format: 'iife', target: 'chrome120', define: { TFOLD_EDITION: '"store"', TFOLD_DEV: 'false' }, write: false }).then((result) => result.outputFiles?.[0]?.text ?? '');

beforeAll(async () => {
	[browser, server, contentScript, internals] = await Promise.all([
		chromium.launch(),
		startFixtureServer(),
		bundle({ entryPoints: [path.join(import.meta.dirname, 'index.ts')] }),
		bundle({
			stdin: {
				contents: [
					"import { ladder } from '../fold/align.ts';",
					"import { localFold, tokenize } from '../fold/local.ts';",
					"import { briefNodes } from './brief-dom.ts';",
					"import { read, textOf } from './text.ts';",
					'Object.assign(globalThis, { internals: { ladder, localFold, tokenize, briefNodes, read, textOf } });',
				].join('\n'),
				resolveDir: import.meta.dirname,
				loader: 'ts',
			},
		}),
	]);
});

afterAll(async () => {
	await browser.close();
	await server.close();
});

async function folded(html: string, brief?: number[]): Promise<{ page: Page; sentences: string[] }> {
	const page = await browser.newPage();
	await page.setContent(`<main>${html}</main>`);
	await page.evaluate((brief) => {
		const sent: FoldRequest[] = [];
		const answer = (request: FoldRequest) =>
			brief
				? { ok: true, folds: request.blocks.map(({ sentences }) => ({ sentences, brief, key: 'A key line.', takeaway: 'A takeaway' })) }
				: { ok: false, error: 'no-key' };
		const sendMessage = (message: { type: string; request: FoldRequest }) =>
			message.type === 'fold' ? (sent.push(message.request), Promise.resolve(answer(message.request))) : Promise.resolve(undefined);
		Object.assign(globalThis, { sent, chrome: { runtime: { sendMessage, onMessage: { addListener() {} } }, i18n: { getUILanguage: () => 'en' }, storage: { sync: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } } } });
	}, brief);
	await page.addScriptTag({ content: contentScript });
	await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [block] = tf.readBlocks();
		if (!block) throw new Error('no block');
		tf.setLevel(block.id, 1);
	});
	const want = brief ? 'model' : 'local';
	await page.locator(`[data-tfold-overlay][data-tf-fold="${want}"]`).waitFor();
	await page.waitForFunction(() => document.querySelector('tfold-ghosts') === null);
	const sentences = await page.evaluate(() => (globalThis as unknown as { sent: FoldRequest[] }).sent[0]?.blocks[0]?.sentences ?? []);
	return { page, sentences };
}

// The Brief's markup without inline styles, where tfold sets each copy's look.
const overlayHtml = (page: Page) =>
	page.locator('[data-tfold-overlay]').evaluate((overlay) => {
		const copy = overlay.cloneNode(true) as Element;
		for (const el of copy.querySelectorAll('[style]')) el.removeAttribute('style');
		return copy.innerHTML;
	});

test('a sentence that ends inside a link keeps the link, cut where the sentence ends', async () => {
	const { page } = await folded(
		'<p>The first sentence holds a <a href="/x" id="a1">link whose text ends here. The second sentence</a> carries on with more words after it.</p>',
	);
	expect(await overlayHtml(page)).toBe('The first sentence holds a <a href="/x">link whose text ends here.</a>');
	await page.close();
});

test('a citation mark after the sentence comes with it, a superscript link with no id', async () => {
	const { page } = await folded(
		'<p>Black holes bend the light that passes them.<sup class="reference" id="cite_ref-1"><a href="#cite_note-1">[1]</a></sup> ' +
			'A second sentence follows with enough words to count.</p>',
	);
	expect(await overlayHtml(page)).toBe('Black holes bend the light that passes them.<sup class="reference"><a href="#cite_note-1">[1]</a></sup>');
	expect(await page.locator('[data-tfold-overlay] sup').evaluate((sup) => getComputedStyle(sup).verticalAlign)).toBe('super');
	await page.close();
});

test('a formula comes whole, and the model reads its TeX', async () => {
	const formula = (hidden: string) =>
		`<span class="mwe-math-element"><span${hidden}><math alttext="{\\displaystyle M_{\\odot }}"><mi>M</mi></math></span>` +
		'<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="{\\displaystyle M_{\\odot }}"></span>';
	const { page, sentences } = await folded(`<p>The unit ${formula(' style="display: none;"')}은 태양질량이다. 이 관계는 전하량과 각운동량이 0인 블랙홀에 대해서만 정확하게 성립한다.</p>`);
	expect(sentences[0]).toBe('The unit M_{\\odot }은 태양질량이다.');
	expect(await overlayHtml(page)).toBe(`The unit ${formula('')}은 태양질량이다.`);
	const shown = (selector: string) => page.locator(`[data-tfold-overlay] ${selector}`).evaluate((el) => el.checkVisibility());
	expect({ math: await shown('math'), image: await shown('img') }).toEqual({ math: false, image: true });
	await page.close();
});

test('a superscript reaches the model as ^ and keeps its markup in the Brief', async () => {
	const { page, sentences } = await folded(
		'<p>The object has a mass of 4.3×10<sup>6</sup> <var>M</var><sub>☉</sub> by the latest fit. A second sentence follows here with words.</p>',
	);
	expect(sentences[0]).toBe('The object has a mass of 4.3×10^6 M_☉ by the latest fit.');
	expect(await overlayHtml(page)).toBe('The object has a mass of 4.3×10<sup>6</sup> <var>M</var><sub>☉</sub> by the latest fit.');
	await page.close();
});

test("copied text looks like its original when the page styles it by the paragraph's id or attributes, and a relative size applies once", async () => {
	const { page } = await folded(
		'<style>#post { color: rgb(40, 40, 40); font: 16px sans-serif } #post > .lead { color: rgb(200, 10, 10); font-family: serif }' +
			' [data-post] a { color: rgb(10, 150, 10) } .big { font-size: 1.5em }</style>' +
			'<p id="post" data-post><span class="lead">The opening words are red</span>, then a <a href="/x">green link</a> and ' +
			'<em class="big">big words</em> follow in the first sentence. The second sentence is plain.</p>',
	);
	const looks = await page.evaluate(() => {
		const look = (el: Element | null | undefined) => {
			if (!el) throw new Error('missing element');
			const style = getComputedStyle(el);
			return `${style.color} ${style.fontFamily} ${style.fontSize}`;
		};
		const overlay = document.querySelector('[data-tfold-overlay]');
		return ['.lead', 'a', '.big'].map((selector) => ({ original: look(document.querySelector(`#post ${selector}`)), copy: look(overlay?.querySelector(selector)) }));
	});
	expect(looks).toEqual([
		{ original: 'rgb(200, 10, 10) serif 16px', copy: 'rgb(200, 10, 10) serif 16px' },
		{ original: 'rgb(10, 150, 10) sans-serif 16px', copy: 'rgb(10, 150, 10) sans-serif 16px' },
		{ original: 'rgb(40, 40, 40) sans-serif 24px', copy: 'rgb(40, 40, 40) sans-serif 24px' },
	]);
	await page.close();
});

test('a Brief of sentences 0 and 2 keeps both apart, and 1 and 2 stay one piece with the link across them', async () => {
	const html =
		'<p id="p">First of four sentences is here. Second one opens a <a href="/y">link that runs. Into the third</a> one. Fourth closes the paragraph.</p>';
	const apart = await folded(html, [0, 2]);
	expect(await overlayHtml(apart.page)).toBe('First of four sentences is here. <a href="/y">Into the third</a> one.');
	await apart.page.close();
	const joined = await folded(html, [1, 2]);
	expect(await overlayHtml(joined.page)).toBe('Second one opens a <a href="/y">link that runs. Into the third</a> one.');
	await joined.page.close();
});

test('a click on a copied button or link clicks the page element once, and a modified click stays on the copy', async () => {
	const { page } = await folded(
		'<p>The counter <button id="b" onclick="window.clicks = (window.clicks ?? 0) + 1; this.textContent = window.clicks">0</button> ' +
			'counts clicks, <a id="dialog" href="#dialog">this link</a> opens a dialog, and <a href="#elsewhere">that link</a> goes elsewhere.</p>' +
			'<script>document.getElementById("dialog").addEventListener("click", (event) => { event.preventDefault(); window.dialogs = (window.dialogs ?? 0) + 1; });</script>',
	);
	const counts = () => page.evaluate(() => [(globalThis as unknown as { clicks?: number }).clicks, (globalThis as unknown as { dialogs?: number }).dialogs, location.hash]);
	await page.locator('[data-tfold-overlay] button').click();
	await expect.poll(() => page.locator('[data-tfold-overlay] button').textContent()).toBe('1');
	expect(await page.locator('#b').textContent()).toBe('1');
	await page.locator('[data-tfold-overlay] a[href="#dialog"]').click();
	expect(await counts()).toEqual([1, 1, '']);
	await page.locator('[data-tfold-overlay] a[href="#dialog"]').click({ modifiers: ['Shift'] });
	expect(await counts()).toEqual([1, 1, '']);
	await page.locator('[data-tfold-overlay] a[href="#elsewhere"]').click();
	expect(await counts()).toEqual([1, 1, '#elsewhere']);
	await page.close();
});

test('a copied form field adds nothing to what the form submits or checks', async () => {
	const { page } = await folded(
		'<form id="pay"><p>Pay <input name="amount" value="10"> euros once you agree <input type="checkbox" name="terms" required> to the terms, ' +
			'which this one sentence keeps for the order.</p></form>',
	);
	expect(await page.locator('[data-tfold-overlay] input').first().inputValue()).toBe('10');
	expect(
		await page.evaluate(() => {
			const form = document.getElementById('pay') as HTMLFormElement;
			(form.querySelector('[name="terms"]') as HTMLInputElement).checked = true;
			return { amount: new FormData(form).getAll('amount'), valid: form.checkValidity() };
		}),
	).toEqual({ amount: ['10'], valid: true });
	await page.close();
});

test('a click on a copy reaches the element that replaced its original, when the page swaps in an equal one', async () => {
	const { page } = await folded(
		'<p id="p">The counter <button>count</button> sits in a sentence with enough words to be one block on its own here.</p>' +
			'<script>document.querySelector("#p button").addEventListener("click", () => { window.old = (window.old ?? 0) + 1; });</script>',
	);
	await page.evaluate(() => {
		const old = document.querySelector('#p button') as Element;
		const fresh = old.cloneNode(true);
		fresh.addEventListener('click', () => Object.assign(globalThis, { fresh: ((globalThis as unknown as { fresh?: number }).fresh ?? 0) + 1 }));
		old.replaceWith(fresh);
	});
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
	await page.locator('[data-tfold-overlay] button').click();
	expect(await page.evaluate(() => [(globalThis as unknown as { old?: number }).old, (globalThis as unknown as { fresh?: number }).fresh])).toEqual([undefined, 1]);
	await page.close();
});

test('a morph keeps hiding its own images when a neighbor overlay goes away in the middle of it', async () => {
	const gif = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
	const paragraph = (name: string) =>
		`<p id="${name}">The first ${name} sentence holds <img class="${name}" src="${gif}" width="12" height="12"> a picture. ` +
		`The second ${name} sentence adds more words to count here.</p>`;
	const page = await browser.newPage();
	await page.setContent(`<main>${paragraph('a')}${paragraph('b')}${paragraph('c')}</main>`);
	await page.evaluate(() =>
		Object.assign(globalThis, {
			chrome: {
				runtime: { sendMessage: () => Promise.resolve({ ok: false, error: 'no-key' }), onMessage: { addListener() {} } },
				i18n: { getUILanguage: () => 'en' },
				storage: { sync: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } },
			},
		}),
	);
	await page.addScriptTag({ content: contentScript });
	const levels = (changes: [string, number][]) =>
		page.evaluate((changes) => {
			type Hook = { blockAt(node: Node): { id: string } | undefined; setLevel(id: string, level: number): void };
			const tf = (globalThis as unknown as { __tfold: Hook }).__tfold;
			for (const [selector, level] of changes) {
				const block = tf.blockAt(document.querySelector(selector) as Element);
				if (!block) throw new Error(`${selector} is not a block`);
				tf.setLevel(block.id, level);
			}
		}, changes);
	await levels([['#a', 1], ['#b', 1]]);
	await page.waitForFunction(() => document.querySelector('tfold-ghosts') === null);
	await levels([['#b', 0], ['#a', 0]]);
	const shown = await page.evaluate(() => {
		for (const animation of document.getAnimations()) {
			animation.pause();
			animation.currentTime = 50;
		}
		return Object.fromEntries(['a', 'b', 'c'].map((name) => [name, document.querySelector(`#${name} img`)?.checkVisibility({ checkVisibilityCSS: true })]));
	});
	expect(shown).toEqual({ a: false, b: false, c: true });
	await page.close();
});

for (const fixture of ['/wikipedia-black-hole/', '/wikipedia-ko-black-hole/', '/arxiv-2401.04088/']) {
	test(`${fixture}: each sentence of each paragraph, copied from the page, reads as the Brief words the morph expects`, async () => {
		const page = await browser.newPage();
		await page.goto(new URL(fixture, server.baseURL).href, { waitUntil: 'load' });
		await page.addScriptTag({ content: internals });
		const result = await page.evaluate(() => {
			type Fold = { sentences: string[]; brief: number[]; key: string; takeaway: string };
			const { ladder, localFold, tokenize, briefNodes, read, textOf } = (globalThis as unknown as {
				internals: {
					ladder: (fold: Fold) => readonly (readonly { t: string }[])[];
					localFold: (text: string) => Fold;
					tokenize: (text: string) => { t: string }[];
					briefNodes: (el: Element, fold: Fold) => Node[];
					read: (el: Element) => { text: string };
					textOf: (el: Element) => string;
				};
			}).internals;
			const mismatches: string[] = [];
			let briefs = 0;
			for (const el of document.querySelectorAll('article p, main p, #mw-content-text p, .ltx_para p')) {
				const text = textOf(el);
				if (text.split(' ').length < 12) continue;
				const fold = localFold(text);
				for (const index of fold.sentences.keys()) {
					const brief = { ...fold, brief: [index] };
					const overlay = document.createElement(el.localName);
					overlay.className = el.className;
					overlay.append(...briefNodes(el, brief));
					el.after(overlay);
					const shown = tokenize(read(overlay).text).map((token) => token.t);
					overlay.remove();
					const want = (ladder(brief)[1] ?? []).map((word) => word.t);
					briefs++;
					if (shown.join(' ') !== want.join(' ')) mismatches.push(`${want.join(' ')}\n  read ${shown.join(' ')}`);
				}
			}
			return { briefs, mismatches };
		});
		await page.close();
		expect(result.briefs).toBeGreaterThan(100);
		expect(result.mismatches).toEqual([]);
	});
}
