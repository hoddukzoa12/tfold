import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../e2e/fixture-server.ts';
import type { StoredTranslation } from '../translation.ts';
import { promptFor, readAnswer, schemaFor, type FoldRequest } from './prompt.ts';
import type { BlockId } from './types.ts';

let browser: Browser;
let server: FixtureServer;
let contentScript: string;

beforeAll(async () => {
	const bundle = build({
		entryPoints: [path.join(import.meta.dirname, '..', 'content', 'index.ts')],
		bundle: true,
		format: 'iife',
		target: 'chrome120',
		define: { TFOLD_EDITION: '"store"', TFOLD_DEV: 'false' },
		write: false,
	});
	[browser, server, contentScript] = await Promise.all([
		chromium.launch(),
		startFixtureServer(),
		bundle.then((result) => result.outputFiles[0]?.text ?? ''),
	]);
});

afterAll(async () => {
	await browser.close();
	await server.close();
});

async function withContentScript(page: Page, stored: StoredTranslation = {}): Promise<void> {
	await page.evaluate((stored) => {
		const sent: unknown[] = [];
		const answer = (message: { request: FoldRequest }) => ({
			ok: true,
			folds: message.request.blocks.map(({ sentences }) => ({ sentences, brief: [0], key: 'Key.', takeaway: 'Takeaway' })),
		});
		const sendMessage = (message: { type: string; request: FoldRequest }) =>
			message.type === 'fold' ? (sent.push(message), Promise.resolve(answer(message))) : Promise.resolve(undefined);
		const runtime = { sendMessage, onMessage: { addListener() {} } };
		const storage = { sync: { get: () => Promise.resolve(stored) }, onChanged: { addListener() {} } };
		const i18n = { getUILanguage: () => 'en-US' };
		Object.assign(globalThis, { sent, chrome: { ...(globalThis as { chrome?: object }).chrome, runtime, storage, i18n } });
	}, stored);
	await page.addScriptTag({ content: contentScript });
	await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
}

async function requestFor(fixture: string, heading: string, stored: StoredTranslation = {}): Promise<FoldRequest> {
	const page = await browser.newPage();
	await page.goto(new URL(fixture, server.baseURL).href, { waitUntil: 'load' });
	await withContentScript(page, stored);
	const message = await page.evaluate((selector) => {
		type Tf = { blockAt(node: Node): { id: string } | undefined; setLevel(id: string, level: number): void };
		const tf = (globalThis as unknown as { __tfold: Tf }).__tfold;
		const heading = document.querySelector(selector)?.closest('h1, h2, h3, h4, h5, h6');
		if (!heading) throw new Error(`no heading ${selector}`);
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
		walker.currentNode = heading;
		while (walker.nextNode()) {
			const block = tf.blockAt(walker.currentNode);
			if (block) {
				tf.setLevel(block.id, 1);
				return (globalThis as unknown as { sent: unknown[] }).sent[0];
			}
		}
		throw new Error(`no block after ${selector}`);
	}, heading);
	await page.close();
	return (message as { request: FoldRequest }).request;
}

test('the prompt for the Mass section of the Wikipedia fixture', async () => {
	const request = await requestFor('/wikipedia-black-hole/', '#Mass');
	expect(request.outline[request.section]).toEqual({ depth: 3, text: 'Mass' });
	expect(request.outline.map((heading) => heading.text)).not.toContain('Contents');
	expect(request.blocks).toHaveLength(3);
	expect(request.lang).toBe('en');
	expect(request.translateTo).toBeUndefined();
	await expect(promptFor(request)).toMatchFileSnapshot('__snapshots__/prompt-wiki-mass.txt');
});

test('with auto-translate on, a Korean reader gets the Mass section in Korean, names kept with Korean in parentheses and known places in Korean', async () => {
	const request = await requestFor('/wikipedia-black-hole/', '#Mass', { autoTranslate: true, readerLanguage: 'ko' });
	expect(request.translateTo).toBe('ko');
	const prompt = promptFor(request);
	expect(prompt).toContain('takeaway: ONE Korean sentence of at most 14 words');
	expect(prompt).toContain('as in Sam Altman(샘 올트먼), Microsoft(마이크로소프트) or self-attention(셀프 어텐션)');
	expect(prompt).toContain('in Korean alone, as in 중국, 미국, 서울 or 런던');
	await expect(prompt).toMatchFileSnapshot('__snapshots__/prompt-wiki-mass-ko.txt');
	const { translateTo, ...untranslated } = request;
	expect(promptFor(untranslated)).toBe(await readFile(path.join(import.meta.dirname, '__snapshots__', 'prompt-wiki-mass.txt'), 'utf8'));
	expect(translateTo).toBe('ko');
});

test('auto-translate asks for no translation where the paragraph is already in the reader language, is on by default, and stays off once turned off', async () => {
	const koreanReader = { autoTranslate: true, readerLanguage: 'ko' };
	expect((await requestFor('/wikipedia-ko-black-hole/', '#형성과_진화', koreanReader)).translateTo).toBeUndefined();
	expect((await requestFor('/wikipedia-black-hole/', '#Mass', { readerLanguage: 'ko' })).translateTo).toBe('ko');
	expect((await requestFor('/wikipedia-black-hole/', '#Mass', { autoTranslate: false, readerLanguage: 'ko' })).translateTo).toBeUndefined();
	expect((await requestFor('/wikipedia-ko-black-hole/', '#형성과_진화', { autoTranslate: true })).translateTo).toBe('en');
});

async function sentOn(html: string, stored: StoredTranslation, folds: number[]): Promise<FoldRequest[]> {
	const page = await browser.newPage();
	await page.setContent(html);
	await withContentScript(page, stored);
	const requests = await page.evaluate(async (folds) => {
		type Tf = { blockAt(node: Node): { id: string } | undefined; setLevel(id: string, level: number): void };
		const tf = (globalThis as unknown as { __tfold: Tf }).__tfold;
		const sent = (globalThis as unknown as { sent: { request: FoldRequest }[] }).sent;
		for (const n of folds) {
			const block = tf.blockAt(document.querySelectorAll('p:not([data-tfold-overlay])')[n] as Element);
			if (!block) throw new Error(`paragraph ${n} is not a block`);
			tf.setLevel(block.id, 1);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return sent.map(({ request }) => request);
	}, folds);
	await page.close();
	return requests;
}

async function mixedSection(stored: StoredTranslation): Promise<{ lang: string; translateTo: string | undefined; firsts: (string | undefined)[] }[]> {
	const english = (n: number) => `<p>English paragraph ${n} of this section says one more plain thing about the topic at hand.</p>`;
	const korean = '<p>이 문단은 영어로 선언된 페이지 안에 있지만 한국어로 쓰였고, 같은 절의 다른 문단과 따로 접힌다.</p>';
	const html = `<html lang="en"><body><main><h2>Mixed</h2>${english(0)}${korean}${english(1)}${english(2)}<h2>Next</h2></main></body></html>`;
	return (await sentOn(html, stored, [0, 1])).map((request) => ({
		lang: request.lang,
		translateTo: request.translateTo,
		firsts: request.blocks.map((block) => block.sentences[0]?.slice(0, 19)),
	}));
}

test('a Korean paragraph on a page that declares English is asked on its own, for Korean lines, with or without auto-translate', async () => {
	const englishFirsts = ['English paragraph 0', 'English paragraph 1', 'English paragraph 2'];
	const koreanFirst = ['이 문단은 영어로 선언된 페이지 안'];
	expect(await mixedSection({ autoTranslate: true, readerLanguage: 'ko' })).toEqual([
		{ lang: 'en', translateTo: 'ko', firsts: englishFirsts },
		{ lang: 'ko', translateTo: undefined, firsts: koreanFirst },
	]);
	expect(await mixedSection({ autoTranslate: false })).toEqual([
		{ lang: 'en', translateTo: undefined, firsts: englishFirsts },
		{ lang: 'ko', translateTo: undefined, firsts: koreanFirst },
	]);
});

const undeclared = {
	French: 'La tour Eiffel, construite pour l’Exposition universelle de 1889, devait être démontée après vingt ans, mais la radio l’a sauvée.',
	German: 'Der Bundestag hat am Donnerstag ein Gesetz beschlossen, das die Förderung von Wärmepumpen bis zum Jahr 2030 verlängert.',
	Spanish: 'El Museo del Prado, inaugurado en 1819 en Madrid, guarda una de las colecciones de pintura europea más completas del mundo.',
	English: 'The Eiffel Tower, built for the 1889 World Fair, was meant to come down after twenty years, but radio saved it.',
};

test.each(Object.entries(undeclared))(
	'on a page with no lang, a paragraph in %s asks for lines in its own language exactly as before, and only a Korean reader gets it translated',
	async (_, text) => {
		const html = `<html><head><title>A page</title></head><body><main><h2>A section</h2><p>${text}</p><h2>Next</h2></main></body></html>`;
		const [off] = await sentOn(html, {}, [0]);
		if (!off) throw new Error('no request was sent');
		expect(off.lang).toBe('');
		expect(off).not.toHaveProperty('translateTo');
		expect(promptFor(off)).toContain('takeaway: ONE sentence of at most 14 words');
		expect(await sentOn(html, { autoTranslate: true, readerLanguage: 'en' }, [0])).toEqual([off]);
		const [korean] = await sentOn(html, { autoTranslate: true, readerLanguage: 'ko' }, [0]);
		expect(korean).toEqual({ ...off, translateTo: 'ko' });
		expect(promptFor(korean as FoldRequest)).toContain("- point: ONE sentence in the text's own language of at most 14 words");
	},
);

test('a paragraph takes the lang that it or its nearest ancestor declares, not the page lang', async () => {
	const html = `<html lang="en"><body><main><h2>Mixed</h2><p lang="fr">${undeclared.French}</p><section lang="de"><p>${undeclared.German}</p></section><h2>Next</h2></main></body></html>`;
	const asked = async (stored: StoredTranslation) => (await sentOn(html, stored, [0, 1])).map(({ lang, translateTo }) => ({ lang, translateTo }));
	expect(await asked({ autoTranslate: false })).toEqual([
		{ lang: 'fr', translateTo: undefined },
		{ lang: 'de', translateTo: undefined },
	]);
	expect(await asked({ autoTranslate: true, readerLanguage: 'en' })).toEqual([
		{ lang: 'fr', translateTo: 'en' },
		{ lang: 'de', translateTo: 'en' },
	]);
});

test('a translated answer marks its folds as written in the reader language, and a unit left as written stays unmarked', () => {
	const asked = { ...request([['First sentence.', 'Second sentence.'], ['A label']]), translateTo: 'ko' as const };
	const folds = readAnswer(asked, {
		units: [
			{ id: 'U0', point: 'Sam Altman wrote the first sentence', takeaway: 'Sam Altman(샘 올트먼)은 첫 문장을 썼다', reason: '', evidence: [1] },
			{ id: 'U1', point: '', takeaway: '', reason: '', evidence: [] },
		],
	});
	expect(folds?.map((fold) => [fold.takeaway, fold.writtenIn])).toEqual([
		['Sam Altman(샘 올트먼)은 첫 문장을 썼다.', 'ko'],
		['A label', undefined],
	]);
});

test('a translated request asks for the main point in the text\'s own language before the Korean lines, and an untranslated one does not', () => {
	const asked = request([['First sentence.', 'Second sentence.']]);
	const translated = { ...asked, translateTo: 'ko' as const };
	const fields = (each: FoldRequest) => schemaFor(each).properties.units.items;
	expect(Object.keys(fields(translated).properties)).toEqual(['id', 'point', 'takeaway', 'reason', 'evidence']);
	expect(fields(translated).required).toEqual(['id', 'point', 'takeaway', 'reason', 'evidence']);
	expect(promptFor(translated)).toContain('- point: ONE English sentence of at most 14 words');
	expect(Object.keys(fields(asked).properties)).toEqual(['id', 'takeaway', 'reason', 'evidence']);
	expect(promptFor(asked)).not.toContain('- point:');
});

const request = (sentences: string[][], lang = 'en'): FoldRequest => ({
	url: 'https://example.org/',
	title: 'A title',
	lang,
	outline: [{ depth: 2, text: 'A section' }],
	section: 0,
	blocks: sentences.map((list, i) => ({ id: `b${i}` as BlockId, tag: 'p', sentences: list })),
});

test('a Korean page asks for Korean lines in words, and a Chinese page for lines in characters', () => {
	const korean = promptFor(request([['블랙홀은 빛조차 빠져나올 수 없는 천체입니다.', '일반 상대성 이론이 그 존재를 예측했습니다.']], 'ko'));
	expect(korean).toContain('takeaway: ONE Korean sentence of at most 14 words');
	const chinese = promptFor(request([['黑洞是一种天体。', '它的引力极强，连光都无法逃脱。']], 'zh'));
	expect(chinese).toContain('takeaway: ONE sentence of at most 40 characters');
	expect(chinese).toContain("use the punctuation of the text's own language");
});

test('an answer becomes one fold per block: Brief is sentence indices, Key is the takeaway and its reason', () => {
	const asked = request([
		['First sentence.', 'Second sentence.', 'Third sentence.'],
		['Only sentence here.'],
	]);
	const folds = readAnswer(asked, {
		units: [
			{ id: 'U0', takeaway: 'Black holes trap light — even light.', reason: 'Gravity wins.', evidence: [2, 7, 0, 2] },
			{ id: 'U1', takeaway: '', reason: '', evidence: [] },
		],
	});
	expect(folds).toEqual([
		{
			sentences: ['First sentence.', 'Second sentence.', 'Third sentence.'],
			brief: [0, 2],
			key: 'Black holes trap light, even light. Gravity wins.',
			takeaway: 'Black holes trap light, even light.',
		},
		{ sentences: ['Only sentence here.'], brief: [0], key: 'Only sentence here.', takeaway: 'Only sentence here.' },
	]);
});

test('a Takeaway is a sentence that ends with the stop of its own script', () => {
	const unit = (takeaway: string) => ({ units: [{ id: 'U0', takeaway, reason: '', evidence: [0] }] });
	const korean = readAnswer(request([['첫 문장이다.', '둘째 문장이다.']], 'ko'), unit('블랙홀은 주변 물질과의 상호작용으로 알 수 있다'));
	const chinese = readAnswer(request([['第一句。', '第二句。']], 'zh'), unit('黑洞的性质可以通过它与周围物质的相互作用得知。'));
	expect(korean?.[0]?.takeaway).toBe('블랙홀은 주변 물질과의 상호작용으로 알 수 있다.');
	expect(chinese?.[0]?.takeaway).toBe('黑洞的性质可以通过它与周围物质的相互作用得知。');
});

test('an answer with a unit missing, repeated, extra or of the wrong shape is rejected', () => {
	const asked = request([['One.'], ['Two.']]);
	const unit = (id: string) => ({ id, takeaway: 'T', reason: '', evidence: [0] });
	expect(readAnswer(asked, { units: [unit('U0')] })).toBeUndefined();
	expect(readAnswer(asked, { units: [unit('U1'), unit('U1')] })).toBeUndefined();
	expect(readAnswer(asked, { units: [unit('U0'), unit('U1'), unit('U2')] })).toBeUndefined();
	expect(readAnswer(asked, { units: [unit('U0'), { ...unit('U1'), evidence: ['0'] }] })).toBeUndefined();
	expect(readAnswer(asked, 'U0')).toBeUndefined();
});

test('units that come back out of order fold the blocks their ids name', () => {
	const asked = request([['One.', 'Uno.'], ['Two.', 'Dos.'], ['Three.', 'Tres.']]);
	const unit = (n: number) => ({ id: `U${n}`, takeaway: `Block ${n} says ${n}`, reason: '', evidence: [0] });
	const folds = readAnswer(asked, { units: [unit(0), unit(2), unit(1)] });
	expect(folds?.map((fold) => [fold.sentences[0], fold.takeaway])).toEqual([
		['One.', 'Block 0 says 0.'],
		['Two.', 'Block 1 says 1.'],
		['Three.', 'Block 2 says 2.'],
	]);
});

async function windowsAt(stored: StoredTranslation): Promise<number[][]> {
	const page = await browser.newPage();
	const paragraphs = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i} of this long section says one more thing about the topic.</p>`);
	await page.setContent(`<main><h2>A long section</h2>${paragraphs.join('')}<h2>Next</h2></main>`);
	await withContentScript(page, stored);
	const asked = await page.evaluate(async () => {
		type Tf = { blockAt(node: Node): { id: string } | undefined; setLevel(id: string, level: number): void };
		const tf = (globalThis as unknown as { __tfold: Tf }).__tfold;
		const sent = (globalThis as unknown as { sent: { request: FoldRequest }[] }).sent;
		const foldBy = (n: number) => {
			const block = tf.blockAt(document.querySelectorAll('p:not([data-tfold-overlay])')[n] as Element);
			if (!block) throw new Error(`paragraph ${n} is not a block`);
			tf.setLevel(block.id, 1);
		};
		foldBy(20);
		await new Promise((resolve) => setTimeout(resolve, 50));
		foldBy(25);
		return sent.map(({ request }) => request.blocks.map((block) => Number(/^Paragraph (\d+)/.exec(block.sentences[0] ?? '')?.[1])));
	});
	await page.close();
	return asked;
}

test('a fold in a 40-paragraph section asks for the 8 paragraphs around it, and the next fold for 8 not yet folded', async () => {
	expect(await windowsAt({})).toEqual([
		[17, 18, 19, 20, 21, 22, 23, 24],
		[25, 26, 27, 28, 29, 30, 31, 32],
	]);
});

test('translated, a fold asks for the 3 paragraphs around it, and the next fold for 3 not yet folded', async () => {
	expect(await windowsAt({ autoTranslate: true, readerLanguage: 'ko' })).toEqual([
		[19, 20, 21],
		[24, 25, 26],
	]);
});

test('Brief keeps fewer sentences than the paragraph has, and the model\'s best sentences first', () => {
	const asked = request([['One.', 'Two.', 'Three.'], ['One.', 'Two.'], ['Only one.'], ['One.', 'Two.', 'Three.']]);
	const unit = (n: number, evidence: number[]) => ({ id: `U${n}`, takeaway: 'T', reason: '', evidence });
	const folds = readAnswer(asked, { units: [unit(0, [0, 1, 2]), unit(1, [1, 0]), unit(2, [0]), unit(3, [2, 5, 0, 1])] });
	expect(folds?.map((fold) => fold.brief)).toEqual([[0, 1], [1], [0], [0, 2]]);
});
