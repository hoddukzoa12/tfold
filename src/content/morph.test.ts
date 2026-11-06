import { chromium, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';

type Copy = {
	morph: (key: string, view: () => { root: Element; words: readonly unknown[] }, change: () => void) => void;
	clearStrayMorphNodes: () => void;
	words: (el: Element) => readonly unknown[];
};

let browser: Browser;
let copy: string;

// Each script tag of this bundle is one copy of the content script, with a token of its own.
const source = [
	"import { sourceWords } from '../fold/align.ts';",
	"import { clearStrayMorphNodes, morph } from './morph.ts';",
	"import { textOf } from './text.ts';",
	'((globalThis as any).copies ??= []).push({ clearStrayMorphNodes, morph, words: (el: Element) => sourceWords(textOf(el)) });',
].join('\n');

beforeAll(async () => {
	const bundle = build({ stdin: { contents: source, resolveDir: import.meta.dirname, loader: 'ts' }, bundle: true, format: 'iife', target: 'chrome120', write: false });
	[browser, copy] = await Promise.all([chromium.launch(), bundle.then((result) => result.outputFiles[0]?.text ?? '')]);
});

afterAll(async () => {
	await browser.close();
});

test('a copy sweeps only its own leftover ghosts and leaves the morph of another copy running', async () => {
	const page = await browser.newPage();
	await page.setContent('<main><p id="moving">One paragraph that loses the last words it has.</p><p>Another paragraph after it.</p></main>');
	await page.addScriptTag({ content: copy });
	await page.addScriptTag({ content: copy });
	const ghosts = await page.evaluate(() => {
		const [first, second] = (globalThis as unknown as { copies: [Copy, Copy] }).copies;
		const paragraph = document.getElementById('moving') as Element;
		const layers = () => document.querySelectorAll('tfold-ghosts').length;
		first.morph('moving', () => ({ root: paragraph, words: first.words(paragraph) }), () => (paragraph.textContent = 'One paragraph.'));
		const running = layers();
		document.body.append((document.querySelector('tfold-ghosts') as Element).cloneNode(true));
		const copiedByThePage = layers();
		second.clearStrayMorphNodes();
		const afterTheOtherCopySweeps = layers();
		first.clearStrayMorphNodes();
		return { running, copiedByThePage, afterTheOtherCopySweeps, afterItsOwnSweep: layers() };
	});
	expect(ghosts).toEqual({ running: 1, copiedByThePage: 2, afterTheOtherCopySweeps: 2, afterItsOwnSweep: 1 });
	await page.close();
});
