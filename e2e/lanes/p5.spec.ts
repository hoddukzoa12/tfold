import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { fixtures, launch, type Harness } from '../harness.ts';
import { expect, test } from '../lane.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'e2e', 'out', 'p5');
const latchMs = 400;
const wikiParagraphs = '#mw-content-text section > p:not(.mw-empty-elt):not([data-tfold-overlay])';
const koWiki = '/wikipedia-ko-black-hole/';
const marked = '[data-p5-block]';
const keplerian = 'https://en.wikipedia.org/wiki/Keplerian_orbit';
const keplerianLinks = [keplerian, 'https://en.wikipedia.org/wiki/Black_hole#cite_note-Gillessen-213'];

const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const nth = (selector: string, index: number) => `${selector} >> nth=${index}`;
const overlayOf = (block: string) => `${block} + [data-tfold-overlay]`;

async function fresh(slug: string): Promise<string> {
	const file = path.join(outDir, `${slug}.png`);
	await mkdir(outDir, { recursive: true });
	await rm(file, { force: true });
	return file;
}

function sh(command: string, args: string[], cwd = repoRoot): string {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr}`);
	return result.stdout.trim();
}

type Pick = (sentences: string[]) => number;
type Mock = { prompts: string[]; close(): Promise<void> };

const containing =
	(needle: string): Pick =>
	(sentences) =>
		Math.max(0, sentences.findIndex((sentence) => sentence.includes(needle)));

function mockAnswer(prompt: string, pick: Pick): string {
	const units = prompt.split(/^\[U\d+\][^\n]*\n/m).slice(1);
	return JSON.stringify({
		units: units.map((unit, n) => {
			const sentences = [...unit.matchAll(/^ {2}\d+: (.*)$/gm)].map(([, sentence]) => sentence ?? '');
			const evidence = pick(sentences);
			const words = (sentences[evidence] ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
			return { id: `U${n}`, takeaway: `${words.slice(0, 6).join(' ')} in short`, reason: `It ${words.slice(6, 12).join(' ')}`, evidence: [evidence] };
		}),
	});
}

async function mockProvider(h: Harness, pick: Pick = () => 0): Promise<Mock> {
	const prompts: string[] = [];
	const server = http.createServer((request, response) => {
		const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
		if (request.method === 'OPTIONS') {
			response.writeHead(204, cors).end();
			return;
		}
		let raw = '';
		request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		request.on('end', () => {
			const body = JSON.parse(raw) as { messages: { content: string }[] };
			const prompt = body.messages.at(-1)?.content ?? '';
			prompts.push(prompt);
			response.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(
				JSON.stringify({
					id: 'gen-mock',
					choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: mockAnswer(prompt, pick) } }],
					usage: { prompt_tokens: 0, completion_tokens: 0 },
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	await h.worker.evaluate((provider) => chrome.storage.local.set({ provider }), {
		kind: 'openai-compatible',
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: 'mock-key',
		model: 'mock/model',
	});
	return {
		prompts,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

async function settle(page: Page): Promise<void> {
	await page.waitForFunction(() => document.querySelector('tfold-ghosts, tfold-gap') === null);
	await page.waitForTimeout(100);
}

async function foldBy(h: Harness, selector: string, steps: number): Promise<void> {
	const point = await h.pointAt(selector);
	await h.foldAt(point.x, point.y, steps);
}

async function markBlock(h: Harness, page: string, selector: string, text: string): Promise<string> {
	await h.navigate(page);
	await h.page.evaluate(
		({ selector, text }) => {
			const el = [...document.querySelectorAll(selector)].find((candidate) => candidate.textContent?.includes(text));
			if (!el) throw new Error(`no ${selector} holds ${text}`);
			el.setAttribute('data-p5-block', '');
			el.scrollIntoView({ block: 'start' });
			scrollBy(0, -160);
		},
		{ selector, text },
	);
	return marked;
}

async function foldWithModel(h: Harness, block: string, steps = 1): Promise<Locator> {
	await foldBy(h, block, steps);
	const overlay = h.page.locator(overlayOf(block));
	await expect(h.page.locator(`${overlayOf(block)}[data-tf-fold="model"]`)).toHaveCount(1, { timeout: 15_000 });
	await settle(h.page);
	await h.page.waitForTimeout(latchMs);
	return overlay;
}

async function unfold(h: Harness, block: string, steps = 1): Promise<void> {
	await foldBy(h, overlayOf(block), -steps);
	await expect(h.page.locator(overlayOf(block))).toHaveCount(0);
	await settle(h.page);
	await h.page.waitForTimeout(latchMs);
}

const hrefs = (overlay: Locator) => overlay.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
const elementCount = (overlay: Locator) => overlay.evaluate((el) => el.querySelectorAll('*').length);

async function around(page: Page, locator: Locator, file?: string, margin = 24): Promise<Buffer> {
	const box = await locator.boundingBox();
	if (!box) throw new Error('the element has no box');
	const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
	const x = Math.max(0, box.x - margin);
	const y = Math.max(0, box.y - margin);
	return page.screenshot({ path: file, clip: { x, y, width: Math.min(viewport.width - x, box.width + 2 * margin), height: Math.min(viewport.height - y, box.height + 2 * margin) } });
}

test.describe('lanes with a mock model', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'] });

	test("lane 1: a Brief shows the page's own sentence with its own links", async ({ h }) => {
		const png = await fresh('p5-links');
		const mock = await mockProvider(h, containing('Keplerian'));
		const block = await markBlock(h, fixtures.wiki, wikiParagraphs, 'Keplerian orbits');
		const overlay = await foldWithModel(h, block);
		const links = await hrefs(overlay);
		const text = await overlay.innerText();
		await around(h.page, overlay, png);
		await mock.close();
		console.log(`Brief links ${JSON.stringify(links)}: ${text}`);
		expect(links).toEqual(keplerianLinks);
		expect(text).toContain('Keplerian orbits');
		expect(errors(h)).toEqual([]);
	});

	test('lane 2: a click on a link inside a Brief overlay opens the link target', async ({ h }) => {
		const png = await fresh('p5-click');
		const mock = await mockProvider(h, containing('Keplerian'));
		const block = await markBlock(h, fixtures.wiki, wikiParagraphs, 'Keplerian orbits');
		const overlay = await foldWithModel(h, block);
		await mock.close();
		await h.page.route(keplerian, (route) =>
			route.fulfill({
				contentType: 'text/html',
				body: `<!doctype html><title>Keplerian orbit</title><h1>Keplerian orbit</h1><p>The lane serves this page in place of ${keplerian}.</p>`,
			}),
		);
		const link = overlay.locator(`a[href="${keplerian}"]`);
		await expect(link).toHaveCount(1);
		const original = await h.page.locator(`${block} a[href="${keplerian}"]`).evaluate((a) => getComputedStyle(a).color);
		const shown = await link.evaluate((a) => getComputedStyle(a).color);
		await h.click(`${overlayOf(block)} a[href="${keplerian}"]`);
		await h.page.waitForURL(keplerian);
		await h.page.screenshot({ path: png });
		console.log(`link color on the page ${original}, in the overlay ${shown}; after the click the tab is at ${h.page.url()}`);
		expect(shown).toBe(original);
		expect(h.page.url()).toBe(keplerian);
		expect(await h.page.locator('h1').textContent()).toBe('Keplerian orbit');
	});

	test('lane 3: a citation mark in the Brief keeps its superscript and its link', async ({ h }) => {
		const png = await fresh('p5-cite');
		const mock = await mockProvider(h, containing('Keplerian'));
		const block = await markBlock(h, fixtures.wiki, wikiParagraphs, 'Keplerian orbits');
		const overlay = await foldWithModel(h, block);
		await mock.close();
		const marks = overlay.locator('sup.reference');
		await expect(marks).toHaveCount(1);
		const mark = await marks.evaluate((sup) => {
			const link = sup.querySelector('a');
			const before = document.createRange();
			const text = sup.previousSibling;
			if (!(text instanceof Text)) throw new Error('no text before the mark');
			before.setStart(text, text.length - 1);
			before.setEnd(text, text.length);
			const [mark, word] = [sup.getBoundingClientRect(), before.getBoundingClientRect()];
			const style = getComputedStyle(sup);
			return {
				href: link?.getAttribute('href'),
				text: sup.textContent,
				verticalAlign: style.verticalAlign,
				fontSize: parseFloat(style.fontSize),
				textSize: parseFloat(getComputedStyle(sup.parentElement ?? sup).fontSize),
				raised: mark.top < word.top - 1,
			};
		});
		await h.page.locator(overlayOf(block)).evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await around(h.page, overlay, png);
		console.log(`citation mark in the Brief: ${JSON.stringify(mark)}`);
		expect(mark.href).toBe(keplerianLinks[1]);
		expect(mark.text).toBe('[213]');
		expect(mark.verticalAlign).toBe('super');
		expect(mark.fontSize).toBeLessThan(mark.textSize);
		expect(mark.raised).toBe(true);
		expect(errors(h)).toEqual([]);
	});

	test('lane 4: an arXiv Brief with inline math renders the math inside the overlay', async ({ h }) => {
		const png = await fresh('p5-math');
		const mock = await mockProvider(h, containing('MoE module'));
		const block = await markBlock(h, fixtures.arxiv, 'p.ltx_p', 'The output of the MoE module');
		const formulas = await h.page.locator(block).evaluate((el) => [...el.querySelectorAll('math')].map((math) => math.getAttribute('alttext')));
		const overlay = await foldWithModel(h, block);
		await mock.close();
		const shown = await overlay.locator('math').evaluateAll((maths) =>
			maths.map((math) => {
				const rect = math.getBoundingClientRect();
				return { alttext: math.getAttribute('alttext'), width: rect.width, height: rect.height, visible: math.checkVisibility({ checkVisibilityCSS: true }) };
			}),
		);
		await around(h.page, overlay, png);
		console.log(`formulas in the paragraph: ${JSON.stringify(formulas)}; in the Brief: ${JSON.stringify(shown)}`);
		expect(shown.map((math) => math.alttext)).toEqual(['x', 'n', String.raw`\{E_{0},E_{i},...,E_{n-1}\}`]);
		for (const math of shown) {
			expect(math.visible).toBe(true);
			expect(math.width).toBeGreaterThan(4);
			expect(math.height).toBeGreaterThan(4);
		}
		expect(errors(h)).toEqual([]);
	});

	test('lane 5: ten folded paragraphs carry the page links and no id appears twice', async ({ h }) => {
		test.setTimeout(120_000);
		const png = await fresh('p5-ids');
		const mock = await mockProvider(h);
		await h.navigate(fixtures.wiki);
		const duplicates = () =>
			h.page.evaluate(() => {
				const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
				return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
			});
		const before = await duplicates();
		for (let i = 0; i < 10; i++) {
			await foldBy(h, nth(wikiParagraphs, i), 1);
			await h.page.waitForTimeout(latchMs + 50);
		}
		await expect(h.page.locator('[data-tfold-overlay][data-tf-fold="model"]')).toHaveCount(10, { timeout: 15_000 });
		await settle(h.page);
		const after = await duplicates();
		const links = await h.page.locator('[data-tfold-overlay] a[href]').count();
		const linksWithIds = await h.page.evaluate(() => [...document.querySelectorAll('[data-tfold-hidden] a[id]')].length);
		await h.page.screenshot({ path: png });
		await mock.close();
		console.log(`ids that appear twice before folding: ${JSON.stringify(before)}, after: ${JSON.stringify(after)}`);
		console.log(`${links} links in the ten Briefs; the ten hidden originals hold ${linksWithIds} links with an id`);
		expect(before).toEqual([]);
		expect(after).toEqual([]);
		expect(links).toBeGreaterThan(10);
		expect(errors(h)).toEqual([]);
	});

	test('lane 6: Key is one line of plain text, after a Brief that held the page markup', async ({ h }) => {
		const png = await fresh('p5-key');
		const mock = await mockProvider(h, containing('Keplerian'));
		const block = await markBlock(h, fixtures.wiki, wikiParagraphs, 'Keplerian orbits');
		const overlay = await foldWithModel(h, block);
		const brief = { links: await hrefs(overlay), elements: await elementCount(overlay) };
		await foldBy(h, overlayOf(block), 1);
		await expect(overlay).toHaveAttribute('data-tf-level', '2');
		await settle(h.page);
		await mock.close();
		const key = await overlay.evaluate((el) => ({ nodes: [...el.childNodes].map((node) => node.nodeName), text: el.textContent }));
		await h.page.screenshot({ path: png, clip: (await overlay.boundingBox()) ?? undefined });
		console.log(`Brief: ${brief.elements} elements, links ${JSON.stringify(brief.links)}; Key: ${JSON.stringify(key)}`);
		expect(brief.links).toEqual(keplerianLinks);
		expect(key.nodes).toEqual(['#text']);
		expect(key.text).toBe('By fitting the motions of stars in short. It to Keplerian orbits the astronomers were.');
		expect(errors(h)).toEqual([]);
	});

	test('lane 7: a click on the counter inside a React Brief clicks the page counter, and the overlay shows the new count', async ({ h }) => {
		const png = await fresh('p5-react');
		const mock = await mockProvider(h);
		await h.navigate(fixtures.react);
		const counter = h.page.locator('#counter');
		await expect(counter).toHaveText('0');
		const overlay = await foldWithModel(h, '#counter-paragraph');
		const copy = overlay.locator('button');
		await expect(copy).toHaveText('0');
		await h.click(`${overlayOf('#counter-paragraph')} button`);
		await expect(counter).toHaveText('1');
		await expect(copy).toHaveText('1');
		await h.click(`${overlayOf('#counter-paragraph')} button`);
		await expect(copy).toHaveText('2');
		await h.page.screenshot({ path: png });
		await mock.close();
		console.log(`after two clicks on the overlay's copy, the page counter reads ${await counter.textContent()} and the copy ${await copy.textContent()}`);
		expect(await counter.textContent()).toBe('2');
		expect(errors(h)).toEqual([]);
	});

	test('lane 8: a folded list item keeps its marker and its link', async ({ h }) => {
		const png = await fresh('p5-li');
		const mock = await mockProvider(h);
		const block = await markBlock(h, fixtures.wiki, '#mw-content-text li', 'Two Black Holes on the Cusp of Merging');
		const original = await h.page.locator(block).evaluate((li) => ({
			links: [...li.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
			display: getComputedStyle(li).display,
			marker: getComputedStyle(li).listStyleType,
		}));
		const overlay = await foldWithModel(h, block);
		await mock.close();
		const shown = await overlay.evaluate((li) => ({
			tag: li.localName,
			list: li.parentElement?.localName,
			links: [...li.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
			display: getComputedStyle(li).display,
			marker: getComputedStyle(li).listStyleType,
			markerText: getComputedStyle(li, '::marker').content,
		}));
		await h.page.screenshot({ path: png, clip: (await overlay.boundingBox().then((box) => box && { ...box, x: Math.max(0, box.x - 40), width: box.width + 40 })) ?? undefined });
		console.log(`list item on the page: ${JSON.stringify(original)}; folded: ${JSON.stringify(shown)}`);
		expect(shown.tag).toBe('li');
		expect(shown.list).toBe('ul');
		expect(shown.display).toBe('list-item');
		expect(shown.marker).toBe(original.marker);
		expect(shown.links.length).toBeGreaterThan(0);
		expect(shown.links).toEqual(original.links.slice(0, shown.links.length));
		expect(errors(h)).toEqual([]);
	});

	test('lane 9: searching the page for a linked word in the Brief finds it in the overlay link', async ({ h }) => {
		const png = await fresh('p5-find');
		const mock = await mockProvider(h, containing('Keplerian'));
		const block = await markBlock(h, fixtures.wiki, wikiParagraphs, 'Keplerian orbits');
		await foldWithModel(h, block);
		await mock.close();
		const hits = await h.page.evaluate(() => {
			getSelection()?.removeAllRanges();
			const seen: { selected: string; where: string; link: string | null }[] = [];
			while (seen.length < 50 && (window as unknown as { find(text: string): boolean }).find('Keplerian')) {
				const node = getSelection()?.anchorNode;
				const el = node instanceof Element ? node : node?.parentElement;
				const where = el?.closest('[data-tfold-overlay]') ? 'overlay' : el?.closest('[data-tfold-hidden]') ? 'hidden original' : 'page';
				seen.push({ selected: getSelection()?.toString() ?? '', where, link: el?.closest('a')?.getAttribute('href') ?? null });
				if (where === 'overlay') break;
			}
			return seen;
		});
		await h.page.screenshot({ path: png });
		console.log(`each find('Keplerian') from the top of the page: ${JSON.stringify(hits)}`);
		expect(hits.at(-1)).toEqual({ selected: 'Keplerian', where: 'overlay', link: keplerian });
		expect(hits.filter((hit) => hit.where === 'hidden original')).toEqual([]);
		expect(errors(h)).toEqual([]);
	});

	test('lane 10: five folds and unfolds leave the original outerHTML as it was', async ({ h }) => {
		test.setTimeout(120_000);
		const png = await fresh('p5-cycle');
		const mock = await mockProvider(h, containing('Keplerian'));
		const block = await markBlock(h, fixtures.wiki, wikiParagraphs, 'Keplerian orbits');
		const snapshot = await h.page.locator(block).evaluate((el) => el.outerHTML);
		const links: (string | null)[][] = [];
		for (let i = 0; i < 5; i++) {
			const overlay = await foldWithModel(h, block);
			links.push(await hrefs(overlay));
			await unfold(h, block);
		}
		await mock.close();
		const restored = await h.page.locator(block).evaluate((el) => el.outerHTML);
		await h.page.screenshot({ path: png });
		console.log(`links in each of the five Briefs: ${JSON.stringify(links.map((list) => list.length))}`);
		expect(links).toEqual(Array.from({ length: 5 }, () => keplerianLinks));
		expect(restored).toBe(snapshot);
		expect(await h.page.locator('[data-tfold-overlay], [data-tfold-hidden], tfold-ghosts, tfold-gap').count()).toBe(0);
		expect(errors(h)).toEqual([]);
	});

	test('lane 11: the model reads 4.3×10^6 M_☉ and the TeX of each formula, not digits glued together', async ({ h }) => {
		const png = await fresh('p5-request');
		const mock = await mockProvider(h, containing('Keplerian'));
		const block = await markBlock(h, fixtures.wiki, wikiParagraphs, 'Keplerian orbits');
		await foldWithModel(h, block);
		const english = mock.prompts.flatMap((prompt) => prompt.split('\n')).filter((line) => line.includes('Keplerian'));
		await writeFile(path.join(outDir, 'request-english.txt'), mock.prompts.find((prompt) => prompt.includes('Keplerian')) ?? '');
		const korean = await markBlock(h, koWiki, wikiParagraphs, '태양질량');
		await foldWithModel(h, korean);
		await mock.close();
		const koreanLines = mock.prompts.flatMap((prompt) => prompt.split('\n')).filter((line) => line.includes('태양질량이다'));
		await h.showText('The sentences the mock model received', [...english, ...koreanLines].join('\n\n'));
		await h.page.screenshot({ path: png });
		console.log(`English: ${JSON.stringify(english)}`);
		console.log(`Korean: ${JSON.stringify(koreanLines)}`);
		expect(english).toHaveLength(1);
		expect(english[0]).toContain('must have a mass of 4.3×10^6 M_☉, with a radius');
		expect(english[0]).not.toContain('4.3×106');
		expect(koreanLines).toHaveLength(1);
		expect(koreanLines[0]).toContain(String.raw`이때 M은 블랙홀의 질량, r_{\mathrm {sh} }는 슈바르츠실트 반경, M_{\odot }은 태양질량이다.`);
		expect(errors(h)).toEqual([]);
	});

	type Case = { name: string; page: string; find: string; from: string; to: string; links: string[]; slug: string };
	type Seen = { t: number; linkColors: string[]; shown: Record<string, number>; at: Record<string, number[]> };

	for (const { name, page, find, from, to, links, slug } of [
		{ name: 'a Korean', page: koWiki, find: '태양질량', from: '', to: '태양질량', links: ['태양질량'], slug: 'p5-paused-korean' },
		{ name: 'an English', page: fixtures.wiki, find: 'satisfy the inequality', from: 'The net electric charge', to: 'Gravitational constant', links: ['vacuum', 'permittivity'], slug: 'p5-paused-english' },
	] satisfies Case[]) {
		test(`lane 12: paused morphs of ${name} Brief with a link and formulas keep the link color and never draw a formula twice`, async ({ h }) => {
			test.setTimeout(180_000);
			const mock = await mockProvider(h, containing(find));
			const block = await markBlock(h, page, wikiParagraphs, find);
			const { formulas, linkColor } = await h.page.locator(block).evaluate(
				(el, { from, to, link }) => {
					const html = el.innerHTML;
					const sentence = html.slice(html.indexOf(from), html.indexOf(to));
					const formulas = [...el.querySelectorAll('.mwe-math-element img')].map((img) => img.getAttribute('src') ?? '').filter((src) => sentence.includes(src));
					const anchor = [...el.querySelectorAll('a')].find((a) => a.textContent?.includes(link));
					return { formulas, linkColor: anchor ? getComputedStyle(anchor).color : '' };
				},
				{ from, to, link: links[0] ?? '' },
			);
			await foldWithModel(h, block);
			await unfold(h, block);
			await mock.close();
			const pausedAt = async (label: string): Promise<Seen[]> => {
				await h.page.waitForFunction(() => document.querySelector('tfold-ghosts') !== null);
				const end = await h.page.evaluate(() => Math.max(...document.getAnimations().map((animation) => Number(animation.effect?.getComputedTiming().endTime ?? 0))));
				const frames: Seen[] = [];
				for (const t of [0, 40, 80, 160, 240, 320, end]) {
					frames.push(
						await h.page.evaluate(
							({ t, formulas, links }) => {
								for (const animation of document.getAnimations()) {
									animation.pause();
									animation.currentTime = t;
								}
								const opacity = (el: Element) => {
									let value = 1;
									for (let node: Element | null = el; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
									return value;
								};
								const linkColors = [...document.querySelectorAll('tfold-ghosts [data-tf-ghost="move"]')]
									.filter((ghost) => links.includes(ghost.textContent ?? '') && opacity(ghost) > 0.1)
									.map((ghost) => getComputedStyle(ghost).color);
								const drawn = [...document.querySelectorAll('[data-p5-block] img, [data-p5-block] + [data-tfold-overlay] img, tfold-ghosts img')].filter(
									(img) => img.checkVisibility({ checkVisibilityCSS: true }) && opacity(img) > 0.1 && img.getBoundingClientRect().width > 0,
								);
								const shown = Object.fromEntries(formulas.map((src) => [src, drawn.filter((img) => img.getAttribute('src') === src).length]));
								const at = Object.fromEntries(
									formulas.map((src) => {
										const rect = drawn.find((img) => img.getAttribute('src') === src)?.getBoundingClientRect();
										return [src, rect ? [rect.left, rect.top] : []];
									}),
								);
								return { t, linkColors, shown, at };
							},
							{ t, formulas, links },
						),
					);
					await h.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
					await h.page.screenshot({ path: await fresh(`${slug}-${label}-${String(Math.round(t)).padStart(3, '0')}ms`) });
				}
				await h.page.evaluate(() => document.getAnimations().forEach((animation) => animation.play()));
				await settle(h.page);
				await h.page.waitForTimeout(latchMs);
				return frames;
			};
			await foldBy(h, block, 1);
			const toBrief = await pausedAt('full-brief');
			await foldBy(h, overlayOf(block), 1);
			await settle(h.page);
			await h.page.waitForTimeout(latchMs);
			await foldBy(h, overlayOf(block), -1);
			const keyToBrief = await pausedAt('key-brief');
			const inBrief = await h.page.locator(`${overlayOf(block)} .mwe-math-element img`).evaluateAll((imgs) => imgs.map((img) => img.checkVisibility({ checkVisibilityCSS: true })));
			await foldBy(h, overlayOf(block), -1);
			const toFull = await pausedAt('brief-full');
			const inFull = await h.page.locator(`${block} .mwe-math-element img`).evaluateAll((imgs) => imgs.filter((img) => img.checkVisibility({ checkVisibilityCSS: true })).length);
			const travel = (frames: Seen[]) =>
				Math.max(
					...formulas.map((src) => {
						const [[x0 = 0, y0 = 0] = [], [x1 = 0, y1 = 0] = []] = [frames[0]?.at[src], frames.at(-1)?.at[src]];
						return Math.hypot(x1 - x0, y1 - y0);
					}),
				);
			for (const [direction, frames] of [['Full to Brief', toBrief], ['Key to Brief', keyToBrief], ['Brief to Full', toFull]] as const) {
				for (const frame of frames) console.log(`${direction} at ${Math.round(frame.t)} ms: kept link words drawn in ${JSON.stringify(frame.linkColors)}, each formula drawn ${JSON.stringify(Object.values(frame.shown))} times`);
			}
			console.log(`link color ${linkColor}; ${formulas.length} formulas in the kept sentence travel up to ${travel(toBrief).toFixed(0)} px to Brief and ${travel(toFull).toFixed(0)} px back`);
			expect(formulas.length).toBeGreaterThanOrEqual(3);
			for (const [direction, frames] of [['Full to Brief', toBrief], ['Key to Brief', keyToBrief], ['Brief to Full', toFull]] as const) {
				for (const frame of frames) {
					const t = `${direction} at ${Math.round(frame.t)} ms`;
					if (direction !== 'Key to Brief') expect(frame.linkColors, `${t}: kept link words`).toEqual(frame.linkColors.map(() => linkColor));
					expect(Object.values(frame.shown).every((count) => count <= 1), `${t}: each formula drawn at most once`).toBe(true);
				}
			}
			expect(toBrief.every((frame) => frame.linkColors.length >= links.length)).toBe(true);
			expect(inBrief).toEqual(formulas.map(() => true));
			expect(inFull).toBe(formulas.length);
			expect(errors(h)).toEqual([]);
		});
	}
});

async function presenter(h: Harness, started: number) {
	await h.page.setViewportSize({ width: 1280, height: 720 });
	await h.page.addInitScript(() => {
		addEventListener('DOMContentLoaded', () => {
			const dot = document.body.appendChild(document.createElement('div'));
			dot.id = 'tf-dot';
			dot.style.cssText =
				'position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(220,40,40,.45);border:2px solid #fff;pointer-events:none;z-index:2147483647;left:-50px;top:-50px';
			const caption = document.body.appendChild(document.createElement('div'));
			caption.id = 'tf-caption';
			caption.style.cssText =
				'position:fixed;left:16px;bottom:16px;max-width:900px;padding:8px 14px;border-radius:8px;background:rgba(20,20,20,.85);color:#fff;font:600 18px system-ui;pointer-events:none;z-index:2147483647;display:none';
			addEventListener('mousemove', (event) => {
				dot.style.left = `${event.clientX}px`;
				dot.style.top = `${event.clientY}px`;
			});
		});
	});
	const say = (text: string) =>
		h.page.evaluate((value) => {
			const caption = document.getElementById('tf-caption');
			if (caption) Object.assign(caption, { textContent: value }).style.display = value ? 'block' : 'none';
		}, text);
	const at = (seconds: number) => ((Date.now() - started) / 1000 - seconds).toFixed(2);
	const moveTo = async (selector: string) => {
		const box = await h.page.locator(selector).first().boundingBox();
		if (!box) throw new Error(`${selector} has no box`);
		const point = { x: box.x + Math.min(box.width / 2, 260), y: box.y + Math.min(box.height / 2, 24) };
		await h.page.mouse.move(point.x, point.y, { steps: 10 });
		return point;
	};
	const step = async (selector: string, steps: number, text: string, hold: number) => {
		const point = await moveTo(selector);
		await say(text);
		await h.page.waitForTimeout(500);
		console.log(`fold ${steps > 0 ? '+' : ''}${steps} at ${at(0)} s: ${text}`);
		await h.foldAt(point.x, point.y, steps);
		await h.page.waitForTimeout(hold);
	};
	return { say, step, moveTo, at };
}

async function encode(videoDir: string, mp4: string): Promise<void> {
	const [webm] = (await readdir(videoDir)).filter((name) => name.endsWith('.webm'));
	if (!webm) throw new Error('Playwright wrote no video');
	sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(videoDir, webm), '-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
	const { size } = await stat(mp4);
	const seconds = Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]));
	console.log(`${path.basename(mp4)}: ${(size / 1e6).toFixed(2)} MB, ${seconds.toFixed(1)} s`);
	expect(size).toBeLessThan(5e6);
	expect(seconds).toBeGreaterThanOrEqual(30);
	expect(seconds).toBeLessThanOrEqual(60);
}

test.describe('video probe', () => {
	const key = process.env.OPENROUTER_API_KEY ?? '';
	test.skip(process.env.TFOLD_PROBE !== 'video', 'TFOLD_PROBE=video records the review videos');

	const record = async (headless: boolean, slug: string, model: 'live' | Pick, scene: (h: Harness, started: number) => Promise<void>) => {
		const videoDir = path.join(outDir, `video-${slug}`);
		const mp4 = path.join(outDir, `${slug}.mp4`);
		await rm(videoDir, { recursive: true, force: true });
		await rm(mp4, { force: true });
		const h = await launch({ headless, allowLiveHosts: ['openrouter.ai', '127.0.0.1'], recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
		const started = Date.now();
		const mock = model === 'live' ? undefined : await mockProvider(h, model);
		try {
			if (!mock) await h.worker.evaluate((apiKey) => chrome.storage.local.set({ provider: { apiKey } }), key);
			await scene(h, started);
			const calls = h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('fold usage '));
			const cost = calls.reduce((sum, entry) => sum + ((JSON.parse(entry.text.slice('fold usage '.length)) as { cost?: number }).cost ?? 0), 0);
			console.log(`${slug}: ${calls.length} ${mock ? 'mock model' : 'OpenRouter'} calls, $${cost.toFixed(6)}`);
			expect(errors(h)).toEqual([]);
		} finally {
			await mock?.close();
			await h.close();
		}
		await encode(videoDir, mp4);
	};

	test('fold a linked English paragraph to Brief and click a link in it', async ({ headless }) => {
		test.skip(key === '', 'OPENROUTER_API_KEY is not set');
		test.setTimeout(300_000);
		await record(headless, 'p5-review', 'live', async (h, started) => {
			const { say, step, moveTo } = await presenter(h, started);
			const block = await markBlock(h, fixtures.wiki, wikiParagraphs, 'Keplerian orbits');
			await say('English Wikipedia, Black hole: a paragraph with links, a superscript and citation marks');
			await h.page.waitForTimeout(2500);
			await step(block, 1, 'Fold to Brief: the local fold shows at once, then the model picks its sentences', 600);
			await expect(h.page.locator(`${overlayOf(block)}[data-tf-fold="model"]`)).toHaveCount(1, { timeout: 30_000 });
			await say('Brief is the page’s own sentences: blue links, 10⁶, M☉ and the citation marks stay');
			await h.page.waitForTimeout(3500);
			await step(overlayOf(block), 1, 'Key: the model wrote this line, so it is plain text', 3000);
			await step(overlayOf(block), -1, 'Back to Brief: the links come back', 3000);
			await step(overlayOf(block), -1, 'Back to Full', 2500);
			await step(block, 1, 'Brief again', 2500);
			const link = h.page.locator(`${overlayOf(block)} a[href^="https://en.wikipedia.org/wiki/"]:not([href*="#"])`).first();
			const href = await link.getAttribute('href');
			if (!href) throw new Error('the Brief holds no article link');
			const title = decodeURIComponent(href.split('/').at(-1) ?? '').replaceAll('_', ' ');
			await h.page.route(href, (route) =>
				route.fulfill({
					contentType: 'text/html',
					body: `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:20px/1.5 system-ui;margin:48px"><h1>${title}</h1><p>The recording serves this page in place of ${href}, because the lanes stay offline.</p></body>`,
				}),
			);
			await say(`Click the link in the Brief: ${await link.innerText()}`);
			await moveTo(`${overlayOf(block)} a[href="${href}"]`);
			await h.page.waitForTimeout(1500);
			await link.click();
			await h.page.waitForURL(href);
			await h.page.waitForTimeout(3500);
			await h.page.goBack();
			await h.page.waitForTimeout(2500);
		});
	});

	test('fold a Korean paragraph with links and the M☉ formula', async ({ headless }) => {
		test.setTimeout(300_000);
		await record(headless, 'p5-review-korean', containing('태양질량'), async (h, started) => {
			const { say, step, moveTo } = await presenter(h, started);
			const block = await markBlock(h, koWiki, wikiParagraphs, '태양질량');
			await say('Korean Wikipedia, 블랙홀: a paragraph with three formula images, a link and a citation mark');
			await h.page.waitForTimeout(3000);
			await say('A stand-in model keeps the sentence with the formulas, so this Brief is the same on every run');
			await h.page.waitForTimeout(3000);
			await step(block, 1, 'Fold to Brief: the rest fades, and the kept sentence stays where it was', 600);
			await expect(h.page.locator(`${overlayOf(block)}[data-tf-fold="model"]`)).toHaveCount(1, { timeout: 30_000 });
			await say('Brief keeps the formulas M, rₛₕ and M☉ as the page draws them, the blue link 태양질량 and the mark [53]');
			await h.page.waitForTimeout(4500);
			await step(overlayOf(block), -1, 'Back to Full: the other sentences fade in, and no formula draws twice', 3000);
			await step(block, 1, 'Brief again', 3000);
			await step(overlayOf(block), -1, 'Full', 2500);
			await step(block, 1, 'Brief', 2500);
			const link = h.page.locator(`${overlayOf(block)} a[title="태양질량"]`);
			const href = await link.getAttribute('href');
			if (!href) throw new Error('the Brief holds no link to 태양질량');
			await h.page.route(href, (route) =>
				route.fulfill({
					contentType: 'text/html',
					body: `<!doctype html><meta charset="utf-8"><title>태양질량</title><body style="font:20px/1.5 system-ui;margin:48px"><h1>태양질량</h1><p>The recording serves this page in place of ${href}, because the lanes stay offline.</p></body>`,
				}),
			);
			await say('Click the link in the Brief: 태양질량');
			await moveTo(`${overlayOf(block)} a[title="태양질량"]`);
			await h.page.waitForTimeout(1500);
			await link.click();
			await h.page.waitForURL(href);
			await h.page.waitForTimeout(3000);
		});
	});
});
