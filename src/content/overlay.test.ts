import { chromium, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';

type Copy = {
	show: (el: Element, overlay: HTMLElement | null, level: 3, shown: { from: 'model'; fold: object }) => HTMLElement;
	restore: (el: Element, overlay: HTMLElement | null) => null;
	clearStrays: (tracked: ReadonlySet<Element>) => void;
};

let browser: Browser;
let overlay: string;

// Each script tag of this bundle is one copy of the content script, with a token of its own.
const copy = "import { clearStrays, restore, show } from './overlay.ts';\n((globalThis as any).copies ??= []).push({ clearStrays, restore, show });";

beforeAll(async () => {
	const bundle = build({
		stdin: { contents: copy, resolveDir: import.meta.dirname, loader: 'ts' },
		bundle: true,
		format: 'iife',
		target: 'chrome120',
		write: false,
	});
	[browser, overlay] = await Promise.all([chromium.launch(), bundle.then((result) => result.outputFiles[0]?.text ?? '')]);
});

afterAll(async () => {
	await browser.close();
});

test('a fold that fails while its overlay is built leaves the paragraph on screen, and one that builds takes its place', async () => {
	const page = await browser.newPage();
	await page.setContent('<p id="broken">This paragraph stays readable when its fold breaks.</p><p id="whole">This paragraph folds to its takeaway.</p>');
	await page.addScriptTag({ content: overlay });
	const shown = await page.evaluate(() => {
		const [{ show }] = (globalThis as unknown as { copies: [Copy] }).copies;
		const paragraph = (id: string) => document.getElementById(id) ?? document.body;
		const fold = (takeaway: () => string) => ({ sentences: [], brief: [], key: '', get takeaway() { return takeaway(); } });
		let error = '';
		try {
			show(paragraph('broken'), null, 3, { from: 'model', fold: fold(() => { throw new Error('the takeaway cannot be read'); }) });
		} catch (caught) {
			error = String(caught);
		}
		const built = show(paragraph('whole'), null, 3, { from: 'model', fold: fold(() => 'The takeaway.') });
		return {
			error,
			broken: paragraph('broken').checkVisibility(),
			whole: paragraph('whole').checkVisibility(),
			overlays: [...document.querySelectorAll('[data-tfold-overlay]')].map((el) => (el.checkVisibility() ? el.textContent : 'hidden')),
			builtAfterWhole: paragraph('whole').nextElementSibling === built,
		};
	});
	expect(shown).toEqual({ error: 'Error: the takeaway cannot be read', broken: true, whole: false, overlays: ['The takeaway.'], builtAfterWhole: true });
	await page.close();
});

const takeaway = (text: string) => ({ from: 'model' as const, fold: { sentences: [], brief: [], key: '', takeaway: text } });

test('a fold drawn beside the fold of a copy from before tokens stays put when either is drawn again, and only it shows', async () => {
	const page = await browser.newPage();
	await page.setContent(
		'<style>[data-tf-hidden]{display:none!important}</style>' +
			'<main><p id="both">Both copies folded this paragraph.</p><p data-tf-overlay="">The fold of the old copy.</p>' +
			'<p id="old" data-tf-hidden="">Only the old copy folded this paragraph.</p><p data-tf-overlay="">Another fold of the old copy.</p></main>',
	);
	await page.addScriptTag({ content: overlay });
	const shown = await page.evaluate(async (fold) => {
		const [{ show }] = (globalThis as unknown as { copies: [Copy] }).copies;
		const both = document.getElementById('both') as Element;
		const old = both.nextElementSibling as Element;
		both.setAttribute('data-tf-hidden', '');
		const ours = show(both, null, 3, fold);
		both.after(old);
		const changes: MutationRecord[] = [];
		new MutationObserver((records) => changes.push(...records)).observe(document.body, { subtree: true, childList: true, attributes: true });
		show(both, ours, 3, fold);
		await new Promise((resolve) => setTimeout(resolve));
		const main = document.querySelector('main') as Element;
		const name = (el: Element) => (el === both ? 'paragraph' : el === old ? 'old fold' : el === ours ? 'this fold' : el.id || 'other old fold');
		return {
			changes: changes.length,
			order: [...main.children].slice(0, 3).map(name),
			shown: [...main.children].filter((el) => el.checkVisibility()).map((el) => el.textContent),
		};
	}, takeaway('The fold of this copy.'));
	expect(shown).toEqual({
		changes: 0,
		order: ['paragraph', 'old fold', 'this fold'],
		shown: ['The fold of this copy.', 'Only the old copy folded this paragraph.'],
	});
	await page.close();
});

test('a fold reads its look with the paragraph hidden, so a second reading writes nothing and its width follows the window', async () => {
	const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
	await page.setContent('<main><p id="p" style="padding: 5%">This paragraph takes the width of the window at any size.</p></main>');
	await page.addScriptTag({ content: overlay });
	const changes = await page.evaluate(async (fold) => {
		const [{ show }] = (globalThis as unknown as { copies: [Copy] }).copies;
		const paragraph = document.getElementById('p') as Element;
		const ours = show(paragraph, null, 3, fold);
		const records: MutationRecord[] = [];
		new MutationObserver((seen) => records.push(...seen)).observe(document.body, { subtree: true, childList: true, attributes: true });
		show(paragraph, ours, 3, fold);
		await new Promise((resolve) => setTimeout(resolve));
		return records.length;
	}, takeaway('The takeaway.'));
	const fitsAt = async (width: number) => {
		await page.setViewportSize({ width, height: 600 });
		return page.locator('[data-tfold-overlay]').evaluate((el) => el.getBoundingClientRect().right <= innerWidth);
	};
	expect({ changes, fits: await fitsAt(500) }).toEqual({ changes: 0, fits: true });
	await page.close();
});

test.each<[string, string, string, boolean]>([
	['a page in the default font', '', '', false],
	['a font from around the block', 'body { font-family: Georgia; }', '', false],
	['a font of its own', 'body { font-family: Georgia; } #p { font-family: Arial; }', 'Arial', true],
	['a font of its own that is the root element\'s but not its parent\'s', 'html { font-family: Georgia; } main { font-family: Arial; } #p { font-family: Georgia; }', 'Georgia', true],
])('a fold names the typeface only when it differs from what its block inherits, on %s', async (_, css, family, pinned) => {
	const page = await browser.newPage();
	await page.setContent(`<style>${css}</style><main><p id="p">This paragraph folds to its takeaway.</p></main>`);
	await page.addScriptTag({ content: overlay });
	const seen = await page.evaluate((fold) => {
		const [{ show }] = (globalThis as unknown as { copies: [Copy] }).copies;
		const paragraph = document.getElementById('p') as Element;
		const before = getComputedStyle(paragraph).fontFamily;
		const ours = show(paragraph, null, 3, fold);
		return { names: ours.getAttribute('style')?.includes('font-family') ?? false, same: getComputedStyle(ours).fontFamily === before, family: getComputedStyle(ours).fontFamily };
	}, takeaway('The takeaway.'));
	expect(seen.names).toBe(pinned);
	expect(seen.same).toBe(true);
	if (family) expect(seen.family).toBe(family);
	await page.close();
});

test('a copy sweeps and puts back only its own folds, also on a paragraph that another copy folded too', async () => {
	const page = await browser.newPage();
	await page.setContent('<main><p id="first">The first copy folded this.</p><p id="second">The second copy folded this.</p><p id="both">Both copies folded this.</p></main>');
	await page.addScriptTag({ content: overlay });
	await page.addScriptTag({ content: overlay });
	const steps = await page.evaluate(() => {
		const fold = (takeaway: string) => ({ from: 'model' as const, fold: { sentences: [], brief: [], key: '', takeaway } });
		const [first, second] = (globalThis as unknown as { copies: [Copy, Copy] }).copies;
		const paragraph = (id: string) => document.getElementById(id) as Element;
		const shown = () => [...document.querySelectorAll('main > *')].filter((el) => el.checkVisibility()).map((el) => el.textContent);
		first.show(paragraph('first'), null, 3, fold('first'));
		second.show(paragraph('second'), null, 3, fold('second'));
		const firstOnBoth = first.show(paragraph('both'), null, 3, fold('first on both'));
		const secondOnBoth = second.show(paragraph('both'), null, 3, fold('second on both'));
		const folded = shown();
		second.restore(paragraph('both'), secondOnBoth);
		const secondPutBack = shown();
		second.clearStrays(new Set());
		const secondSwept = shown();
		first.restore(paragraph('both'), firstOnBoth);
		return { folded, secondPutBack, secondSwept, firstPutBack: shown() };
	});
	expect(steps).toEqual({
		folded: ['first', 'second', 'second on both', 'first on both'],
		secondPutBack: ['first', 'second', 'first on both'],
		secondSwept: ['first', 'The second copy folded this.', 'first on both'],
		firstPutBack: ['first', 'The second copy folded this.', 'Both copies folded this.'],
	});
	await page.close();
});
