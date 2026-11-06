import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { startFixtureServer, type FixtureServer } from '../../e2e/fixture-server.ts';
import { localFold } from '../../src/fold/local.ts';
import type { FoldRequest } from '../../src/fold/prompt.ts';
import type { StoredTranslation } from '../../src/translation.ts';
import { here, readSet, setArg, sets, writeJson, type Captured, type SetName } from './lib.ts';

type Listed = { n: number; id: string; section: number; heading: string; text: string };

const pages = ['/wikipedia-black-hole/', '/wikipedia-ko-black-hole/', '/arxiv-2401.04088/'];

const bundle = await build({
	entryPoints: [path.join(here, '..', '..', 'src', 'content', 'index.ts')],
	bundle: true,
	format: 'iife',
	target: 'chrome120',
	write: false,
});
const contentScript = bundle.outputFiles[0]?.text ?? '';
const content = createHash('sha256').update(contentScript).digest('hex').slice(0, 12);

async function open(browser: Browser, server: FixtureServer, url: string, stored: StoredTranslation = {}): Promise<Page> {
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	await page.goto(new URL(url, server.baseURL).href, { waitUntil: 'load' });
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
	return page;
}

function listBlocks(page: Page): Promise<Listed[]> {
	return page.evaluate(() => {
		type Tf = { blockAt(node: Node): { id: string } | undefined };
		const tf = (globalThis as unknown as { __tfold: Tf }).__tfold;
		const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(
			(heading) => !heading.closest('nav, footer, figure') && heading.checkVisibility(),
		);
		const seen = new Set<string>();
		const listed: Listed[] = [];
		for (const el of document.querySelectorAll('p, li, blockquote, dd')) {
			const block = tf.blockAt(el);
			if (!block || seen.has(block.id)) continue;
			seen.add(block.id);
			const copy = el.cloneNode(true) as Element;
			for (const skip of copy.querySelectorAll('script, style, annotation, annotation-xml')) skip.remove();
			for (const sup of copy.querySelectorAll('sup')) if (/^\[[^\]]*\]$/.test((sup.textContent ?? '').trim())) sup.remove();
			const section = headings.findLastIndex((candidate) => candidate.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
			listed.push({
				n: listed.length,
				id: block.id,
				section,
				heading: (headings[section]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
				text: (copy.textContent ?? '').replace(/\s+/g, ' ').trim(),
			});
		}
		return listed;
	});
}

function foldBlock(page: Page, id: string): Promise<FoldRequest> {
	return page.evaluate((id) => {
		type Tf = { setLevel(id: string, level: number): void };
		const tf = (globalThis as unknown as { __tfold: Tf }).__tfold;
		const sent = (globalThis as unknown as { sent: { request: FoldRequest }[] }).sent;
		tf.setLevel(id, 1);
		const request = sent.at(-1)?.request;
		if (!request || !request.blocks.some((block) => block.id === id)) throw new Error(`no request for block ${id}`);
		return request;
	}, id);
}

async function captureItems(browser: Browser, server: FixtureServer, name: SetName): Promise<void> {
	const set = await readSet(name);
	const calls: FoldRequest[] = [];
	const items: Captured['items'] = {};
	for (const item of set) {
		const page = await open(browser, server, item.page, sets[name].stored);
		const target = (await listBlocks(page)).find((listed) => listed.text.startsWith(item.startsWith));
		if (!target) throw new Error(`${item.id}: no block on ${item.page} starts with ${JSON.stringify(item.startsWith)}`);
		const request = await foldBlock(page, target.id);
		await page.close();
		const block = request.blocks.findIndex((candidate) => candidate.id === target.id);
		const sentences = request.blocks[block]?.sentences ?? [];
		if (sentences.length < 2) throw new Error(`${item.id}: the paragraph has ${sentences.length} sentence, and Brief cannot be shorter`);
		const same = calls.findIndex((known) => JSON.stringify(known) === JSON.stringify(request));
		items[item.id] = { call: same === -1 ? calls.push(request) - 1 : same, block };
		console.log(`${item.id}: call ${items[item.id]?.call}, block ${block} of ${request.blocks.length}, ${sentences.length} sentences`);
	}
	await writeJson(path.join(here, sets[name].requests), { content, items, calls } satisfies Captured);
	console.log(`${set.length} items in ${calls.length} calls, content script ${content}`);
}

async function captureSections(browser: Browser, server: FixtureServer): Promise<void> {
	const calls: FoldRequest[] = [];
	for (const url of pages) {
		const page = await open(browser, server, url);
		const firsts = new Map<number, string>();
		for (const listed of await listBlocks(page)) if (!firsts.has(listed.section)) firsts.set(listed.section, listed.id);
		for (const id of firsts.values()) calls.push(await foldBlock(page, id));
		await page.close();
		console.log(`${url}: ${firsts.size} sections`);
	}
	await writeJson(path.join(here, 'sections.json'), { content, calls });
}

async function list(browser: Browser, server: FixtureServer, url: string): Promise<void> {
	const page = await open(browser, server, url);
	for (const { n, heading, text } of await listBlocks(page)) {
		console.log(`${n}\t${heading}\t${localFold(text).sentences.length}\t${text}`);
	}
	await page.close();
}

const [browser, server] = await Promise.all([chromium.launch(), startFixtureServer()]);
try {
	const mode = process.argv[2];
	if (mode === '--list') await list(browser, server, process.argv[3] ?? pages[0] ?? '');
	else if (mode === '--sections') await captureSections(browser, server);
	else await captureItems(browser, server, setArg());
} finally {
	await browser.close();
	await server.close();
}
