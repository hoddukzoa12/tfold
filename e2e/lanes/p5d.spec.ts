import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { fixtures, type Harness } from '../harness.ts';
import { expect, test } from '../lane.ts';

const outDir = path.resolve(import.meta.dirname, '..', 'out', 'p5d');
const latchMs = 400;
const xLike = '/x-like/';
const divBlog = '/div-blog/';
const divChrome = '/div-chrome/';
const threadsLike = '/threads-like/';
const divTraps = '/div-traps/';
const divShell = '/div-shell/';
const divShellShare = '/div-shell-share/';
const callouts = '/callouts/';
const themes = '/themes/';
const koWiki = '/wikipedia-ko-black-hole/';
const rowHeight = 320;
const wikiLead = '#mw-content-text section > p:not(.mw-empty-elt):not([data-tfold-overlay])';

const post = (id: number) => `article[data-post="${id}"] [data-testid="tweetText"]`;
const thread = (id: number) => `.post[data-post="${id}"] > .body`;
const overlayOf = (block: string) => `${block} + [data-tfold-overlay]`;
const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');
const ready = (h: Harness) => expect.poll(() => h.readBlocks().then((blocks) => blocks.length, () => 0)).toBeGreaterThan(0);
const night = (page: Page) =>
	page.evaluate(() => document.documentElement.classList.replace('skin-theme-clientpref-day', 'skin-theme-clientpref-night'));

type Scheme = 'light' | 'dark';
const wikiSkin = (page: Page, scheme: Scheme) =>
	page.evaluate((dark) => {
		const [day, night] = ['skin-theme-clientpref-day', 'skin-theme-clientpref-night'];
		document.documentElement.classList.replace(dark ? day : night, dark ? night : day);
	}, scheme === 'dark');
const htmlTheme = (page: Page, scheme: Scheme) =>
	page.evaluate((name) => {
		document.documentElement.className = `theme-${name}`;
	}, scheme);

async function shot(page: Page, slug: string): Promise<void> {
	const file = path.join(outDir, `${slug}.png`);
	await mkdir(outDir, { recursive: true });
	await rm(file, { force: true });
	await page.screenshot({ path: file });
}

async function settle(page: Page): Promise<void> {
	await page.waitForFunction(() => document.querySelector('tfold-ghosts, tfold-gap') === null);
	await page.waitForTimeout(latchMs);
}

async function fold(h: Harness, block: string, steps = 1): Promise<void> {
	const point = await h.pointAt(block);
	await h.foldAt(point.x, point.y, steps);
	await expect(h.page.locator(overlayOf(block))).toHaveAttribute('data-tf-level', String(steps));
	await settle(h.page);
}

async function open(h: Harness, url: string): Promise<void> {
	await h.navigate(url);
	await ready(h);
}

test('lane 1: a fold folds a Korean post and Option+Shift+Down folds an English post on the X-like page', async ({ h }) => {
	const state = (selector: string) =>
		h.page.evaluate((selector) => {
			const original = document.querySelector(selector);
			const overlay = original?.nextElementSibling;
			return { hidden: original?.checkVisibility() === false, lang: overlay?.getAttribute('lang'), text: (overlay as HTMLElement | null)?.innerText };
		}, selector);
	await open(h, xLike);
	await fold(h, post(1));
	const shown = [await state(post(1))];
	await h.pointAt(post(6));
	await h.press('Alt+Shift+ArrowDown');
	await expect(h.page.locator(overlayOf(post(6)))).toHaveAttribute('data-tf-level', '1');
	await settle(h.page);
	shown.push(await state(post(6)));
	await shot(h.page, 'p5d-x-fold');
	console.log(`folded posts: ${JSON.stringify(shown)}`);
	expect(shown).toEqual([
		{ hidden: true, lang: 'ko', text: '오늘 아침에 동네 빵집에서 갓 구운 소금빵을 샀는데 줄이 가게 밖까지 길게 늘어서 있었다.' },
		{ hidden: true, lang: 'en', text: 'Our team shipped the new search page today after six weeks of small fixes and long code reviews.' },
	]);
	expect(errors(h)).toEqual([]);
});

test('lane 2: when the page reuses a folded post element for another post, that post shows in full, the fold comes back with its own post, and hiding a folded post removes its overlay', async ({ h }) => {
	await open(h, xLike);
	await fold(h, post(1));
	await h.page.evaluate((selector) => Object.assign(window, { p5dSlot: document.querySelector(selector) }), post(1));
	await h.page.evaluate((y) => scrollTo(0, y), 7 * rowHeight);
	await h.page.waitForFunction(() => document.querySelector('article[data-post="1"]') === null && document.querySelector('article[data-post="7"]') !== null);
	await settle(h.page);
	const recycled = await h.page.evaluate(() => {
		const slot = (window as unknown as { p5dSlot: Element }).p5dSlot;
		return {
			connected: slot.isConnected,
			post: slot.closest('article')?.getAttribute('data-post'),
			shown: slot.checkVisibility(),
			overlays: document.querySelectorAll('[data-tfold-overlay]').length,
			hidden: document.querySelectorAll('[data-tfold-hidden]').length,
		};
	});
	const levelsAway = (await h.readBlocks()).map((block) => block.level);
	await shot(h.page, 'p5d-x-recycled');
	await h.page.evaluate(() => scrollTo(0, 0));
	await h.page.waitForFunction(() => document.querySelector('article[data-post="1"]') !== null);
	await expect(h.page.locator(overlayOf(post(1)))).toHaveAttribute('data-tf-level', '1');
	const back = await h.page.evaluate((selector) => document.querySelector(selector) === (window as unknown as { p5dSlot: Element }).p5dSlot, post(1));
	const levelsBack = (await h.readBlocks()).map((block) => block.level);
	await settle(h.page);
	await fold(h, post(2));
	await h.click('article[data-post="2"] [data-testid="caret"]');
	await expect(h.page.locator('article[data-post="2"] .notice')).toBeVisible();
	const afterHide = await h.page.evaluate(() => ({
		overlays: document.querySelectorAll('article[data-post="2"] [data-tfold-overlay]').length,
		folded: document.querySelectorAll('[data-tfold-overlay]').length,
	}));
	console.log(`post 1's element after the scroll: ${JSON.stringify(recycled)}, levels ${JSON.stringify(levelsAway)}`);
	console.log(`back at the top, the same element holds post 1: ${back}, levels ${JSON.stringify(levelsBack)}; after hiding folded post 2: ${JSON.stringify(afterHide)}`);
	expect(recycled).toEqual({ connected: true, post: '7', shown: true, overlays: 0, hidden: 0 });
	expect(levelsAway).toEqual([0, 0, 0, 0, 0, 0]);
	expect(back).toBe(true);
	expect(levelsBack.toSorted()).toEqual([0, 0, 0, 0, 0, 1]);
	expect(afterHide).toEqual({ overlays: 0, folded: 1 });
	expect(errors(h)).toEqual([]);
});

test('lane 3: after a fold, a click on the post opens it, the mention and hashtag in a Brief open their pages, and Show more shows the whole post', async ({ h }) => {
	await open(h, xLike);
	await fold(h, post(2));
	const brief = h.page.locator(overlayOf(post(2)));
	const links = await brief.locator('a[href]').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')));
	const visit = async (target: string, url: string, landing: string) => {
		await h.click(target);
		await h.page.waitForURL(`**${url}`);
		await expect(h.page.locator(landing)).toBeVisible();
		const reached = new URL(h.page.url()).pathname;
		await h.page.goBack();
		await ready(h);
		return reached;
	};
	const reached = [
		await visit(`${overlayOf(post(2))} a[href="/x-like/hashtag/windowsill"]`, '/x-like/hashtag/windowsill', '[data-testid="hashtag"]'),
		await visit(`${overlayOf(post(2))} a[href="/x-like/mina_gardens"]`, '/x-like/mina_gardens', '[data-testid="profile"]'),
		await visit(`${overlayOf(post(2))} > span >> nth=0`, '/x-like/status/2', '[data-testid="detail"]'),
	];
	await fold(h, post(1), 2);
	reached.push(await visit(overlayOf(post(1)), '/x-like/status/1', '[data-testid="detail"]'));
	await fold(h, post(4));
	await h.click('article[data-post="4"] [data-testid="tweet-text-show-more-link"]');
	await expect(h.page.locator(post(4))).toContainText('so reply here if you can join us.');
	const more = await h.page.evaluate((selector) => {
		const text = document.querySelector(selector);
		return { shown: text?.checkVisibility(), overlay: text?.nextElementSibling?.hasAttribute('data-tfold-overlay') ?? false };
	}, post(4));
	await shot(h.page, 'p5d-x-show-more');
	console.log(`links in the Brief of post 2: ${JSON.stringify(links)}; clicks reached ${JSON.stringify(reached)}; post 4 after Show more: ${JSON.stringify(more)}`);
	expect(links).toEqual(['/x-like/mina_gardens', '/x-like/hashtag/windowsill']);
	expect(reached).toEqual(['/x-like/hashtag/windowsill', '/x-like/mina_gardens', '/x-like/status/2', '/x-like/status/1']);
	expect(more).toEqual({ shown: true, overlay: false });
	expect(errors(h)).toEqual([]);
});

test('lane 4: a blog that writes its paragraphs as divs folds them by fold and by Option+Shift+Down', async ({ h }) => {
	await open(h, divBlog);
	await fold(h, '#first');
	await h.pointAt('#korean');
	await h.press('Alt+Shift+ArrowDown');
	await expect(h.page.locator(overlayOf('#korean'))).toHaveAttribute('data-tf-level', '1');
	await settle(h.page);
	await fold(h, '#nested');
	const shown = await h.page.evaluate(() =>
		['#first', '#korean', '#nested'].map((selector) => {
			const overlay = document.querySelector(selector)?.nextElementSibling as HTMLElement | null;
			return { text: overlay?.innerText, links: [...(overlay?.querySelectorAll('a[href]') ?? [])].map((a) => a.getAttribute('href')) };
		}),
	);
	const callout = await h.page.locator('.callout').evaluate((el) => el.checkVisibility());
	await shot(h.page, 'p5d-div-blog');
	console.log(`folded divs: ${JSON.stringify(shown)}; the callout around the nested paragraph shows: ${callout}`);
	expect(shown).toEqual([
		{
			text: 'I planted six tomato seedlings in late April, and by the end of July only four of them were still standing after the two summer storms that flattened the fence.',
			links: ['/div-blog/storms'],
		},
		{ text: '올해 가장 크게 배운 점은 지지대를 일찍 세워야 한다는 것이다.', links: [] },
		{ text: 'A note for next year: the bed by the north wall gets two fewer hours of sun, so the cherry tomatoes should go there and the large ones should get the warm corner.', links: [] },
	]);
	expect(callout).toBe(true);
	expect(errors(h)).toEqual([]);
});

test('lane 5: navigation, buttons, role=button, menus, toolbars, editable text, text hidden from assistive technology, trend links and the who-to-follow card are never blocks, while the post and the paragraph beside them are', async ({ h }) => {
	const seen: Record<string, Record<string, boolean>> = {};
	for (const [page, control] of [[xLike, post(1)], [divBlog, '#first']] as const) {
		await open(h, page);
		seen[page] = await h.inContent<Record<string, boolean>>(
			`Object.fromEntries([...document.querySelectorAll(${JSON.stringify(`[data-p5d], ${control}`)})].map((el) => [el.getAttribute('data-p5d') ?? 'control', globalThis.__tfold.blockAt(el) !== undefined]))`,
		);
		await h.pointAt('[data-p5d="nav"]');
		await h.press('Alt+Shift+ArrowDown');
		await h.pointAt('[data-p5d="toolbar"]');
		await h.press('Alt+Shift+ArrowDown');
		await h.page.waitForTimeout(latchMs);
		seen[page].overlay = (await h.page.locator('[data-tfold-overlay]').count()) > 0;
	}
	console.log(`a block at each element: ${JSON.stringify(seen)}`);
	expect(seen).toEqual({
		[xLike]: {
			control: true,
			nav: false,
			button: false,
			editable: false,
			'role-button': false,
			'aria-hidden': false,
			menu: false,
			toolbar: false,
			'footer-nav': false,
			trends: false,
			trend: false,
			'who-to-follow': false,
			overlay: true,
		},
		[divBlog]: {
			control: true,
			nav: false,
			toolbar: false,
			button: false,
			'role-button': false,
			'aria-hidden': false,
			footer: false,
			overlay: true,
		},
	});
	expect(errors(h)).toEqual([]);
});

test('lane 6: each fixture keeps its block count, less the navbox list items that are navigation, and the new fixtures count their posts and paragraphs', async ({ h }) => {
	const expected = {
		[fixtures.wiki]: 115,
		[koWiki]: 85,
		[fixtures.arxiv]: 39,
		[fixtures.react]: 3,
		[xLike]: 6,
		[divBlog]: 6,
		[divChrome]: 2,
		[divTraps]: 7,
	};
	const counts: Record<string, number> = {};
	for (const page of Object.keys(expected)) {
		await h.navigate(page);
		await h.page.waitForFunction(() => document.querySelector('#root, #react-root')?.childElementCount !== 0);
		await expect.poll(() => h.readBlocks().then(() => true, () => false)).toBe(true);
		counts[page] = (await h.readBlocks()).length;
	}
	console.log(`blocks per fixture: ${JSON.stringify(counts)}`);
	expect(counts).toEqual(expected);
});

test('lane 7: on a page with no <p>, link rows, breadcrumbs, tag rows, link cards, tabs, options, labels and text inside links, headers, asides, forms and dialogs are not blocks, and a fold on the link row leaves its links', async ({ h }) => {
	await open(h, divChrome);
	const seen = await h.inContent<{ blocks: number; prose: Record<string, boolean>; chrome: Record<string, boolean> }>(
		`(() => {
			const tf = globalThis.__tfold;
			const isBlock = (el) => tf.blockAt(el) !== undefined;
			return {
				blocks: tf.readBlocks().length,
				prose: Object.fromEntries(['#prose-en', '#prose-ko'].map((selector) => [selector, isBlock(document.querySelector(selector))])),
				chrome: Object.fromEntries([...document.querySelectorAll('[data-chrome]')].map((el) => [el.getAttribute('data-chrome'), isBlock(el)])),
			};
		})()`,
	);
	const navbar = '[data-chrome="navbar"]';
	const point = await h.pointAt(navbar);
	await h.foldAt(point.x, point.y, 3);
	await h.page.waitForTimeout(latchMs);
	const afterFold = await h.page.evaluate((selector) => ({
		overlays: document.querySelectorAll('[data-tfold-overlay]').length,
		links: [...document.querySelectorAll(`${selector} a[href]`)].filter((a) => a.checkVisibility()).length,
	}), navbar);
	await shot(h.page, 'p5d-div-chrome');
	console.log(`div-chrome blocks: ${JSON.stringify(seen)}; after a 3-step fold on the link row: ${JSON.stringify(afterFold)}`);
	expect(seen).toEqual({
		blocks: 2,
		prose: { '#prose-en': true, '#prose-ko': true },
		chrome: {
			navbar: false,
			breadcrumb: false,
			header: false,
			hashtags: false,
			mentions: false,
			tab: false,
			option: false,
			label: false,
			'link-card': false,
			'inside-link': false,
			'role-link': false,
			'long-label': false,
			dialog: false,
			aside: false,
			form: false,
			'footer-row': false,
		},
	});
	expect(afterFold).toEqual({ overlays: 0, links: 7 });
	expect(errors(h)).toEqual([]);
});

test('lane 8: an X post that is mostly links, hashtags and mentions is still a block and folds with its links', async ({ h }) => {
	await open(h, xLike);
	const links = (selector: string) =>
		h.page.locator(`${selector} a[href]`).evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')));
	const before = await links(post(5));
	await fold(h, post(5));
	const overlay = h.page.locator(overlayOf(post(5)));
	const folded = { text: await overlay.innerText(), links: await links(overlayOf(post(5))) };
	console.log(`post 5 links before the fold: ${JSON.stringify(before)}; its Brief: ${JSON.stringify(folded)}`);
	expect(before).toHaveLength(9);
	expect(folded.links).toEqual(before);
	expect(errors(h)).toEqual([]);
});

type Look = { ink: string; fontFamily: string; fontSize: string; lineHeight: string };
type Shade = { look: Look; contrast: number };
type Seen = {
	level: number;
	original: Look;
	overlay: Look;
	contrast: number;
	page: Shade[];
	ghosts: Shade[];
	leastLegible: { original: number; overlay: number };
};

function lookAt(page: Page, block: string, level: number): Promise<Seen> {
	return page.evaluate(
		({ block, level }) => {
			const mainText = (root: Element) => {
				const letters = new Map<Element, number>();
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					const holder = node.parentElement;
					const link = holder?.closest('a');
					if (!holder || holder.closest('style, script') || (link && root.contains(link))) continue;
					letters.set(holder, (letters.get(holder) ?? 0) + (node.textContent ?? '').trim().length);
				}
				return [...letters].reduce<[Element, number]>((best, entry) => (entry[1] > best[1] ? entry : best), [root, -1])[0];
			};
			const look = (el: Element) => {
				const style = getComputedStyle(el);
				return { ink: style.webkitTextFillColor, fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight };
			};
			const rgb = (color: string) => (color.match(/[\d.]+/g) ?? []).map(Number);
			const background = (el: Element) => {
				for (let up: Element | null = el; up; up = up.parentElement) {
					const [r = 0, g = 0, b = 0, a = 1] = rgb(getComputedStyle(up).backgroundColor);
					if (a > 0) return [r, g, b];
				}
				return getComputedStyle(document.documentElement).colorScheme.includes('dark') ? [18, 18, 18] : [255, 255, 255];
			};
			const linear = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
			const luminance = ([r = 0, g = 0, b = 0]: number[]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
			const contrast = (color: string, under: number[]) => {
				const [text, back] = [luminance(rgb(color)), luminance(under)];
				return Math.round(((Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05)) * 10) / 10;
			};
			const original = document.querySelector(block);
			const overlay = original?.nextElementSibling;
			if (!original || !overlay?.hasAttribute('data-tfold-overlay')) throw new Error(`no overlay after ${block}`);
			const shown = look(mainText(overlay));
			const under = background(overlay);
			const shade = (seen: Look) => ({ look: seen, contrast: contrast(seen.ink, under) });
			const holders = (root: Element) => {
				const found = new Set<Element>();
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					if ((node.textContent ?? '').trim() !== '' && node.parentElement) found.add(node.parentElement);
				}
				return [...found];
			};
			const leastLegible = (root: Element) =>
				Math.min(...holders(root).map((holder) => contrast(getComputedStyle(holder).webkitTextFillColor, background(holder))));
			const ghosts = (globalThis as unknown as { p5dGhosts?: Look[] }).p5dGhosts ?? [];
			return {
				level,
				original: look(mainText(original)),
				overlay: shown,
				contrast: contrast(shown.ink, under),
				page: holders(original).map((holder) => shade(look(holder))),
				ghosts: ghosts.map(shade),
				leastLegible: { original: leastLegible(original), overlay: leastLegible(overlay) },
			};
		},
		{ block, level },
	);
}

function recordGhosts(page: Page): Promise<void> {
	return page.evaluate(() => {
		const seen: unknown[] = [];
		Object.assign(globalThis, { p5dGhosts: seen });
		const watcher = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) {
					const ghosts = node instanceof Element ? [...(node.matches('tfold-w') ? [node] : []), ...node.querySelectorAll('tfold-w')] : [];
					for (const ghost of ghosts) {
						if ((ghost.textContent ?? '').trim() === '') continue;
						const style = getComputedStyle(ghost);
						seen.push({ ink: style.webkitTextFillColor, fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight });
					}
				}
			}
		});
		watcher.observe(document.documentElement, { childList: true, subtree: true });
	});
}

test('lane 9: at every level, in light and dark, folded text and the words that move between levels keep the color, typeface, size and line height of the page text, and no folded text reads worse than the page text', async ({ h }) => {
	test.setTimeout(300_000);
	const noBanners = (page: Page) => page.evaluate(() => document.querySelectorAll('.cookie').forEach((banner) => banner.remove()));
	const cases: { name: string; url: string; block: string; scheme: 'light' | 'dark'; prepare?: (page: Page) => Promise<unknown> }[] = [
		{ name: 'Wikipedia light', url: fixtures.wiki, block: wikiLead, scheme: 'light' },
		{ name: 'Wikipedia dark', url: fixtures.wiki, block: wikiLead, scheme: 'dark', prepare: night },
		{ name: 'Korean Wikipedia light', url: koWiki, block: wikiLead, scheme: 'light' },
		{ name: 'Korean Wikipedia dark', url: koWiki, block: wikiLead, scheme: 'dark', prepare: night },
		{ name: 'arXiv light', url: fixtures.arxiv, block: '.ltx_abstract p', scheme: 'light' },
		{ name: 'arXiv dark', url: fixtures.arxiv, block: '.ltx_abstract p', scheme: 'dark' },
		{ name: 'X-like light', url: xLike, block: post(2), scheme: 'light' },
		{ name: 'X-like dark, color on the text spans', url: `${xLike}?theme=dark-spans`, block: post(2), scheme: 'dark' },
		{ name: 'X-like dark, color on the post text', url: `${xLike}?theme=dark-block`, block: post(2), scheme: 'dark' },
		{ name: 'div blog light', url: divBlog, block: '#first', scheme: 'light' },
		{ name: 'div blog dark', url: divBlog, block: '#first', scheme: 'dark' },
		{ name: 'div traps, span style from a rule on the div id', url: divTraps, block: '#prose-3', scheme: 'dark', prepare: noBanners },
		{ name: 'div traps, span style from a rule on a data attribute', url: divTraps, block: '#prose-4', scheme: 'dark', prepare: noBanners },
		{ name: 'div traps, span and link style from rules on the <p> id', url: divTraps, block: '#prose-p', scheme: 'dark', prepare: noBanners },
		{ name: 'div traps, a chip whose color and background come from a rule on a data attribute', url: divTraps, block: '#prose-chip', scheme: 'dark', prepare: noBanners },
		{ name: 'callouts light, white letters from a fill color on a dark background', url: callouts, block: '#fill-p', scheme: 'light' },
		{ name: 'callouts light, a link holds most of the text', url: callouts, block: '#link-run', scheme: 'light' },
		{ name: 'callouts dark, a link holds most of the text', url: callouts, block: '#link-run', scheme: 'dark' },
	];
	const results: Record<string, Seen[]> = {};
	for (const { name, url, block, scheme, prepare } of cases) {
		await h.page.emulateMedia({ colorScheme: scheme });
		await open(h, url);
		await prepare?.(h.page);
		const seen: Seen[] = [];
		for (const level of [1, 2, 3]) {
			await recordGhosts(h.page);
			const point = await h.pointAt(level === 1 ? block : overlayOf(block));
			await h.foldAt(point.x, point.y, 1);
			await expect(h.page.locator(overlayOf(block))).toHaveAttribute('data-tf-level', String(level));
			await settle(h.page);
			seen.push(await lookAt(h.page, block, level));
		}
		if (name === 'X-like dark, color on the text spans') await shot(h.page, 'p5d-x-dark-takeaway');
		results[name] = seen;
	}
	await h.page.emulateMedia({ colorScheme: 'light' });
	console.log(`text style per fixture and level: ${JSON.stringify(results)}`);
	for (const [name, seen] of Object.entries(results)) {
		for (const { level, original, overlay, contrast, page, ghosts, leastLegible: least } of seen) {
			const where = `${name}, level ${level}`;
			const pageHas = (key: keyof Look) => new Set(page.map(({ look }) => look[key]));
			const leastLegible = Math.min(4.5, ...page.map((text) => text.contrast));
			expect(overlay, where).toEqual(original);
			expect(contrast, where).toBeGreaterThanOrEqual(4.5);
			expect(least.overlay, `${where}, the least legible folded text`).toBeGreaterThanOrEqual(Math.min(4.5, least.original));
			expect(ghosts.length, where).toBeGreaterThan(0);
			for (const { look, contrast: legible } of ghosts) {
				const font = { fontFamily: look.fontFamily, fontSize: look.fontSize, lineHeight: look.lineHeight };
				expect(
					{ fontFamily: pageHas('fontFamily').has(font.fontFamily), fontSize: pageHas('fontSize').has(font.fontSize), lineHeight: pageHas('lineHeight').has(font.lineHeight) },
					`${where}, a moving word in ${JSON.stringify(font)}`,
				).toEqual({ fontFamily: true, fontSize: true, lineHeight: true });
				expect(legible, `${where}, a moving word in ${look.ink}`).toBeGreaterThanOrEqual(leastLegible);
			}
		}
	}
	expect(errors(h)).toEqual([]);
});

test('lane 10: on a Threads-like feed with no <p>, article or main, every post of twelve words or more folds by fold and by Option+Shift+Down, and the nav bar, action rows and who-to-follow row are never blocks', async ({ h }) => {
	await open(h, threadsLike);
	const seen = await h.inContent<{ blocks: number; posts: Record<string, boolean>; chrome: Record<string, boolean> }>(
		`(() => {
			const tf = globalThis.__tfold;
			const isBlock = (el) => tf.blockAt(el) !== undefined;
			return {
				blocks: tf.readBlocks().length,
				posts: Object.fromEntries([...document.querySelectorAll('.post')].map((post) => [post.dataset.post, isBlock(post.querySelector('.body span[dir="auto"]'))])),
				chrome: Object.fromEntries([...document.querySelectorAll('[data-chrome]')].map((el) => [el.getAttribute('data-chrome'), [el, ...el.querySelectorAll('*')].some(isBlock)])),
			};
		})()`,
	);
	for (const chrome of ['[data-chrome="nav"]', '[data-chrome="actions"]', '[data-chrome="who-to-follow"] .person']) {
		const point = await h.pointAt(chrome);
		await h.foldAt(point.x, point.y, 1);
		await h.page.waitForTimeout(latchMs);
	}
	const chromeOverlays = await h.page.locator('[data-tfold-overlay]').count();
	await fold(h, thread(1));
	await h.pointAt(thread(2));
	await h.press('Alt+Shift+ArrowDown');
	await expect(h.page.locator(overlayOf(thread(2)))).toHaveAttribute('data-tf-level', '1');
	await settle(h.page);
	const folded = await h.page.evaluate(
		(selectors) =>
			selectors.map((selector) => {
				const overlay = document.querySelector(selector)?.nextElementSibling as HTMLElement | null;
				return { hidden: document.querySelector(selector)?.checkVisibility() === false, text: overlay?.innerText };
			}),
		[thread(1), thread(2)],
	);
	await shot(h.page, 'p5d-threads-fold');
	console.log(`threads-like blocks: ${JSON.stringify(seen)}; overlays after a fold on the chrome: ${chromeOverlays}; folded posts: ${JSON.stringify(folded)}`);
	expect(seen).toEqual({
		blocks: 6,
		posts: { 1: true, 2: true, 3: true, 4: false, 5: true, 6: false, 7: true, 8: true },
		chrome: { nav: false, actions: false, 'who-to-follow': false },
	});
	expect(chromeOverlays).toBe(0);
	expect(folded.map((post) => post.hidden)).toEqual([true, true]);
	expect(errors(h)).toEqual([]);
});

test('lane 11: on a page with no <p>, a timestamp row, a line of dates, a breadcrumb that ends in a question, cookie banners, a pricing table and card and text in widget roles, an aside and a page footer landmark are not blocks, and a fold on each leaves no overlay, while the prose beside them folds', async ({ h }) => {
	await open(h, divTraps);
	const seen = await h.inContent<{ blocks: number; prose: Record<string, boolean>; traps: Record<string, boolean> }>(
		`(() => {
			const tf = globalThis.__tfold;
			const isBlock = (el) => tf.blockAt(el) !== undefined;
			return {
				blocks: tf.readBlocks().length,
				prose: Object.fromEntries([...document.querySelectorAll('[id^="prose-"]')].map((el) => [el.id, isBlock(el)])),
				traps: Object.fromEntries([...document.querySelectorAll('[data-trap]')].map((el) => [el.getAttribute('data-trap'), isBlock(el)])),
			};
		})()`,
	);
	console.log(`div-traps blocks: ${JSON.stringify(seen)}`);
	const tried = ['timestamp', 'dated-line', 'breadcrumb-question', 'pricing-cell', 'pricing-card', 'cookie-plain', 'cookie-alertdialog', 'cookie-region', 'menuitemradio', 'radio', 'checkbox', 'switch', 'tooltip'];
	for (const trap of tried) {
		await h.page.locator(`[data-trap="${trap}"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
		const point = await h.pointAt(`[data-trap="${trap}"]`);
		await h.foldAt(point.x, point.y, 1);
		await h.page.waitForTimeout(latchMs);
	}
	const overlays = await h.page.locator('[data-tfold-overlay]').count();
	await fold(h, '#prose-1');
	const brief = await h.page.locator(overlayOf('#prose-1')).innerText();
	await shot(h.page, 'p5d-div-traps');
	console.log(`overlays after a fold on each trap: ${overlays}; Brief of #prose-1: ${JSON.stringify(brief)}`);
	expect(seen).toEqual({
		blocks: 7,
		prose: { 'prose-1': true, 'prose-2': true, 'prose-3': true, 'prose-4': true, 'prose-chip': true, 'prose-p': true, 'prose-long': true },
		traps: {
			timestamp: false,
			'dated-line': false,
			'timestamp-short': false,
			'breadcrumb-question': false,
			breadcrumb: false,
			navbar: false,
			'navbar-spans': false,
			hashtags: false,
			'footer-row': false,
			'pricing-cell': false,
			'pricing-features': false,
			'pricing-card': false,
			'link-card': false,
			'div-in-a': false,
			label: false,
			tab: false,
			option: false,
			link: false,
			menuitem: false,
			menuitemradio: false,
			radio: false,
			checkbox: false,
			switch: false,
			tooltip: false,
			aside: false,
			contentinfo: false,
			'cookie-plain': false,
			'cookie-alertdialog': false,
			'cookie-region': false,
		},
	});
	expect(overlays).toBe(0);
	expect(brief).toBe('The tide came in faster than the charts said it would, and by the time we reached the old pier the sand bar was already under a foot of water.');
	expect(errors(h)).toEqual([]);
});

test('lane 12: in an app shell that fills the window, the messages in its scrolling pane fold, while a banner that scrolls itself, a banner with a scrolling text area, a popup that scrolls itself and a sticky day header are not blocks and a fold on each leaves no overlay', async ({ h }) => {
	await open(h, divShell);
	const seen = await h.inContent<{ blocks: number; prose: Record<string, boolean>; chrome: Record<string, boolean> }>(
		`(() => {
			const tf = globalThis.__tfold;
			const isBlock = (el) => tf.blockAt(el) !== undefined;
			return {
				blocks: tf.readBlocks().length,
				prose: Object.fromEntries([...document.querySelectorAll('[data-prose]')].map((el) => [el.getAttribute('data-prose'), isBlock(el)])),
				chrome: Object.fromEntries([...document.querySelectorAll('[data-chrome]')].map((el) => [el.getAttribute('data-chrome'), isBlock(el)])),
			};
		})()`,
	);
	const overlays: Record<string, number> = {};
	for (const chrome of ['popup', 'consent', 'notice', 'day']) {
		const point = await h.pointAt(`[data-chrome="${chrome}"]`);
		await h.foldAt(point.x, point.y, 1);
		await h.page.waitForTimeout(latchMs);
		overlays[chrome] = await h.page.locator('[data-tfold-overlay]').count();
		if (chrome === 'popup') await h.page.evaluate(() => document.querySelector('.popup')?.remove());
	}
	const center = (selector: string) => h.page.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'center' }));
	await center('[data-prose="2"]');
	await fold(h, '[data-prose="2"]');
	await center('[data-prose="5"]');
	await h.pointAt('[data-prose="5"]');
	await h.press('Alt+Shift+ArrowDown');
	await expect(h.page.locator(overlayOf('[data-prose="5"]'))).toHaveAttribute('data-tf-level', '1');
	await settle(h.page);
	const hidden = await h.page.evaluate(() => [2, 5].map((n) => document.querySelector(`[data-prose="${n}"]`)?.checkVisibility() === false));
	await shot(h.page, 'p5d-div-shell');
	console.log(`div-shell blocks: ${JSON.stringify(seen)}; overlays after a fold on each chrome: ${JSON.stringify(overlays)}`);
	expect(seen).toEqual({
		blocks: 6,
		prose: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true },
		chrome: { day: false, consent: false, notice: false, popup: false },
	});
	expect(overlays).toEqual({ popup: 0, consent: 0, notice: 0, day: 0 });
	expect(hidden).toEqual([true, true]);
	expect(errors(h)).toEqual([]);
});

type FoldSeen = {
	block: string;
	level: number;
	folded: number | null;
	page: number | null;
	reshaped: string[];
	resized: { page: number | null; folded: number } | null;
	restyled: string[];
};

function seeFolds(page: Page): Promise<FoldSeen[]> {
	return page.evaluate(() => {
		const inkProperties = [
			'color', '-webkit-text-fill-color', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'text-shadow',
			'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant-ligatures', 'font-variant-caps',
			'font-variant-numeric', 'font-variant-east-asian', 'font-feature-settings', 'font-variation-settings', 'font-kerning',
			'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'direction',
		];
		const box = [
			'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat', 'background-origin',
			'background-clip', 'color-scheme', 'opacity', 'filter', 'mix-blend-mode', 'box-sizing', 'writing-mode', 'float', 'text-align',
			...['top', 'right', 'bottom', 'left'].flatMap((side) => [`padding-${side}`, `border-${side}-width`, `border-${side}-style`, `border-${side}-color`]),
			...['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((corner) => `border-${corner}-radius`),
		];
		type Rgba = [number, number, number, number];
		const parse = (color: string): Rgba => {
			const [r = 0, g = 0, b = 0, a = 1] = (color.match(/[\d.]+/g) ?? []).map(Number);
			return [r, g, b, a];
		};
		const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
		const dark = matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.documentElement).colorScheme.includes('dark');
		const canvas: Rgba = dark ? [18, 18, 18, 1] : [255, 255, 255, 1];
		const ownLayers = (style: CSSStyleDeclaration): Rgba[][] => {
			const layers: Rgba[][] = [];
			const color = parse(style.backgroundColor);
			if (color[3] > 0) layers.push([color]);
			const stops = (style.backgroundImage.match(/rgba?\([^)]*\)/g) ?? []).map(parse);
			if (stops.length > 0) layers.push(stops);
			return layers;
		};
		const stack = (layers: Rgba[][]) => layers.reduce<Rgba[]>((below, layer) => below.flatMap((shade) => layer.map((top) => over(top, shade))), [canvas]);
		const shades = (el: Element | null): Rgba[] => {
			const layers: Rgba[][] = [];
			for (let up = el; up; up = up.parentElement) {
				const style = getComputedStyle(up);
				if (style.backgroundClip === 'text') continue;
				layers.unshift(...ownLayers(style));
				if (parse(style.backgroundColor)[3] === 1) break;
			}
			return stack(layers);
		};
		const inks = (holder: Element): Rgba[] => {
			const fill = parse(getComputedStyle(holder).webkitTextFillColor);
			if (fill[3] > 0) return [fill];
			for (let up: Element | null = holder; up; up = up.parentElement) {
				const style = getComputedStyle(up);
				if (style.backgroundClip !== 'text') continue;
				const under = shades(up.parentElement);
				return ownLayers(style).flatMap((layer) => layer.flatMap((top) => under.map((shade) => over(top, shade))));
			}
			return [fill];
		};
		const linear = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
		const luminance = ([r, g, b]: Rgba) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
		const contrast = (text: Rgba, back: Rgba) => {
			const [ink, under] = [luminance(over(text, back)), luminance(back)];
			return Math.round(((Math.max(ink, under) + 0.05) / (Math.min(ink, under) + 0.05)) * 10) / 10;
		};
		const shows = (holder: Element, root: Element) => {
			if (getComputedStyle(holder).visibility !== 'visible') return false;
			for (let up: Element | null = holder; up && up !== root; up = up.parentElement) if (getComputedStyle(up).display === 'none') return false;
			return true;
		};
		const leastLegible = (root: Element) => {
			let least: number | null = null;
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const holder = node.parentElement;
				if ((node.textContent ?? '').trim() === '' || !holder || !shows(holder, root)) continue;
				const under = shades(holder);
				for (const ink of inks(holder)) for (const shade of under) least = Math.min(least ?? Infinity, contrast(ink, shade));
			}
			return least;
		};
		const words = (root: Element) => {
			const found: { text: string; look: string }[] = [];
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const holder = node.parentElement;
				if ((node.textContent ?? '').trim() === '' || !holder) continue;
				const style = getComputedStyle(holder);
				found.push({ text: node.textContent ?? '', look: inkProperties.map((name) => style.getPropertyValue(name)).join(' ') });
			}
			return found;
		};
		const inlineSize = (el: Element) => {
			const { width, height } = el.getBoundingClientRect();
			return Math.round(getComputedStyle(el).writingMode.startsWith('vertical') ? height : width);
		};
		const overlays = [...document.querySelectorAll('[data-tfold-overlay]')];
		const originals = overlays.map((overlay) => {
			const original = overlay.previousElementSibling;
			if (!original?.hasAttribute('data-tfold-hidden')) throw new Error('an overlay does not follow its original');
			return original;
		});
		const foldedSizes = overlays.map(inlineSize);
		const swap = (unfolded: boolean) => {
			for (const [i, overlay] of overlays.entries()) {
				originals[i]?.toggleAttribute('data-tfold-hidden', !unfolded);
				if (overlay instanceof HTMLElement) overlay.style.setProperty('display', unfolded ? 'none' : '', unfolded ? 'important' : '');
			}
		};
		swap(true);
		const pageSizes = originals.map((original) => (getComputedStyle(original).display === 'inline' ? null : inlineSize(original)));
		swap(false);
		return overlays.map((overlay, i) => {
			const original = originals[i] as Element;
			const name = original.id ? `#${original.id}` : original.localName;
			const [shown, wanted] = [getComputedStyle(overlay), getComputedStyle(original)];
			const unseen = (property: string) =>
				property.endsWith('-color') && ['none', 'hidden'].includes(wanted.getPropertyValue(property.replace(/color$/, 'style')));
			const level = Number(overlay.getAttribute('data-tf-level'));
			const onPage = words(original);
			const size = { page: pageSizes[i] ?? null, folded: foldedSizes[i] ?? 0 };
			return {
				block: `${location.pathname}${location.search} ${name} "${(original.textContent ?? '').trim().slice(0, 32)}"`,
				level,
				folded: leastLegible(overlay),
				page: leastLegible(original),
				reshaped: box.filter((property) => !unseen(property) && shown.getPropertyValue(property) !== wanted.getPropertyValue(property)),
				resized: size.page !== null && Math.abs(size.page - size.folded) > 1 ? size : null,
				restyled: level !== 1 ? [] : words(overlay)
					.filter(({ text, look }) => !onPage.some((word) => word.text.includes(text) && word.look === look))
					.map(({ text, look }) => `"${text.trim().slice(0, 24)}" in ${look}`),
			};
		});
	});
}

async function foldEvery(h: Harness, level: number): Promise<number> {
	const count = await h.inContent<number>(
		`(() => {
			const tf = globalThis.__tfold;
			const blocks = tf.readBlocks();
			for (const { id } of blocks) tf.setLevel(id, ${level});
			return blocks.length;
		})()`,
	);
	await h.page.waitForFunction(() => document.querySelector('[data-tf-pending]') === null);
	await settle(h.page);
	return count;
}

test('lane 13: at every level, in light and dark, and after the theme switches while folded, every block of every fixture folds in its own background, padding, border, corners, width and writing mode, to text that reads at 4.5 to 1 or better against what is painted under it, or no worse than the page text it replaces, and each word of a Brief keeps the color and typeface it has on the page', async ({ h }) => {
	test.setTimeout(900_000);
	const everyFixture: { url: string; theme?: (page: Page, scheme: Scheme) => Promise<unknown> }[] = [
		{ url: fixtures.wiki, theme: wikiSkin },
		{ url: koWiki, theme: wikiSkin },
		{ url: fixtures.arxiv },
		{ url: fixtures.react },
		{ url: xLike },
		{ url: `${xLike}?theme=dark-spans` },
		{ url: `${xLike}?theme=dark-block` },
		{ url: threadsLike },
		{ url: divBlog },
		{ url: divChrome },
		{ url: divTraps },
		{ url: divShell },
		{ url: callouts },
		{ url: themes, theme: htmlTheme },
	];
	const rows: (FoldSeen & { scheme: string })[] = [];
	const counts: Record<string, number[]> = {};
	for (const { url, theme } of everyFixture) {
		const switchTo = async (scheme: Scheme) => {
			if (theme) await theme(h.page, scheme);
			else await h.page.emulateMedia({ colorScheme: scheme });
		};
		for (const scheme of ['light', 'dark'] as const) {
			const other = scheme === 'light' ? 'dark' : 'light';
			await h.page.emulateMedia({ colorScheme: scheme });
			await open(h, url);
			await theme?.(h.page, scheme);
			for (const level of [1, 2, 3]) {
				const blocks = await foldEvery(h, level);
				const seen = (await seeFolds(h.page)).filter((row) => row.level === level);
				(counts[`${url} ${scheme}`] ??= []).push(blocks, seen.length);
				rows.push(...seen.map((row) => ({ ...row, scheme })));
				if (url === callouts && level !== 2) await shot(h.page, `p5d-callouts-${scheme}-level-${level}`);
				await switchTo(other);
				await settle(h.page);
				rows.push(...(await seeFolds(h.page)).map((row) => ({ ...row, scheme: `${scheme}, then ${other} while folded` })));
				if (url === themes && level === 1) await shot(h.page, `p5d-themes-${scheme}-then-${other}`);
				await switchTo(scheme);
				await settle(h.page);
			}
		}
	}
	await h.page.emulateMedia({ colorScheme: 'light' });
	const unreadable = rows.filter(({ folded, page }) => folded === null || page === null || folded < Math.min(4.5, page));
	const reshaped = rows.filter((row) => row.reshaped.length > 0).map(({ block, scheme, level, reshaped }) => ({ block, scheme, level, reshaped }));
	const resized = rows.filter((row) => row.resized !== null).map(({ block, scheme, level, resized }) => ({ block, scheme, level, resized }));
	const restyled = rows.filter((row) => row.restyled.length > 0).map(({ block, scheme, restyled }) => ({ block, scheme, restyled: restyled.slice(0, 3) }));
	const calloutRows = rows.filter(({ block }) => block.startsWith(callouts));
	console.log(`blocks and overlays per fixture, at levels 1, 2 and 3: ${JSON.stringify(counts)}`);
	const readings = (seen: typeof rows) => JSON.stringify(seen.map(({ block, scheme, level, folded, page }) => `${scheme} ${level} ${block.split(' ')[1]} ${folded} (page ${page})`));
	console.log(`callouts: ${readings(calloutRows)}`);
	console.log(`themes: ${readings(rows.filter(({ block }) => block.startsWith(themes)))}`);
	console.log(`checked ${rows.length} folds, unreadable: ${JSON.stringify(unreadable)}`);
	console.log(`folds whose box differs from their block's: ${JSON.stringify(reshaped)}`);
	console.log(`folds whose width along their lines differs from their block's: ${JSON.stringify(resized)}`);
	console.log(`Brief words whose color or typeface differs from the page: ${JSON.stringify(restyled)}`);
	for (const [where, seen] of Object.entries(counts)) {
		expect(seen[0] ?? 0, `${where}, blocks`).toBeGreaterThan(0);
		for (let i = 0; i < seen.length; i += 2) expect(seen[i + 1], `${where}, overlays at level ${i / 2 + 1}`).toBe(seen[i]);
	}
	expect(calloutRows).toHaveLength(2 * 2 * 3 * 19);
	expect(unreadable).toEqual([]);
	expect(reshaped).toEqual([]);
	expect(resized).toEqual([]);
	expect(restyled).toEqual([]);
	expect(errors(h)).toEqual([]);
});

test('lane 14: a fixed box whose text scrolls in a pane is an app shell once it fills half the window, so a message in one that fills 55 percent folds and a message in one that fills 45 percent does not', async ({ h }) => {
	await open(h, divShellShare);
	const seen = await h.inContent<{ shares: Record<string, number>; prose: Record<string, boolean> }>(
		`(() => {
			const tf = globalThis.__tfold;
			const share = (box) => {
				const { width, height } = box.getBoundingClientRect();
				return Math.round((100 * width * height) / (innerWidth * innerHeight));
			};
			return {
				shares: Object.fromEntries([...document.querySelectorAll('[data-share]')].map((box) => [box.getAttribute('data-share'), share(box)])),
				prose: Object.fromEntries([...document.querySelectorAll('[data-prose]')].map((el) => [el.getAttribute('data-prose'), tf.blockAt(el) !== undefined])),
			};
		})()`,
	);
	const point = await h.pointAt('[data-prose="45"]');
	await h.foldAt(point.x, point.y, 1);
	await h.page.waitForTimeout(latchMs);
	const overlaysAfter45 = await h.page.locator('[data-tfold-overlay]').count();
	await fold(h, '[data-prose="55"]');
	console.log(`div-shell-share: ${JSON.stringify(seen)}; overlays after a fold on the 45 percent message: ${overlaysAfter45}`);
	expect(seen).toEqual({ shares: { 45: 45, 55: 55 }, prose: { 45: false, 55: true } });
	expect(overlaysAfter45).toBe(0);
	expect(errors(h)).toEqual([]);
});

test('lane 15: a theme switched on a wrapper around folds, a class switched inside a block and a style sheet switched by its media attribute restyle the folds, and a theme switched only through the CSSOM, which changes no element, leaves every fold readable until its next reading brings it up to date', async ({ h }) => {
	test.setTimeout(300_000);
	const fresh: (FoldSeen & { step: string })[] = [];
	const unseen: (FoldSeen & { step: string })[] = [];
	const switches: [string, () => void][] = [
		['the wrapper switched to dark', () => document.getElementById('panel')?.classList.replace('panel-light', 'panel-dark')],
		['a term inside a block marked', () => document.getElementById('term')?.classList.replace('term-plain', 'term-marked')],
		['the dusk sheet switched on by its media', () => document.getElementById('dusk')?.setAttribute('media', 'all')],
	];
	await h.page.emulateMedia({ colorScheme: 'light' });
	for (const level of [1, 2, 3]) {
		await open(h, themes);
		await foldEvery(h, level);
		for (const [step, change] of switches) {
			await h.page.evaluate(change);
			await settle(h.page);
			fresh.push(...(await seeFolds(h.page)).map((row) => ({ ...row, step })));
		}
		await h.page.evaluate(() => {
			const sheet = document.querySelector<HTMLStyleElement>('style#night')?.sheet;
			if (sheet) sheet.disabled = false;
		});
		await settle(h.page);
		unseen.push(...(await seeFolds(h.page)).map((row) => ({ ...row, step: 'the night sheet switched on' })));
		if (level === 1) await shot(h.page, 'p5d-themes-night-sheet');
		await foldEvery(h, (level % 3) + 1);
		fresh.push(...(await seeFolds(h.page)).map((row) => ({ ...row, step: `then level ${(level % 3) + 1}` })));
	}
	const name = (row: FoldSeen) => row.block.split(' ')[1] ?? '';
	const readable = (row: FoldSeen) => row.folded !== null && row.page !== null && row.folded >= Math.min(4.5, row.page);
	console.log(`after the wrapper switched and after a level change: ${JSON.stringify(fresh.map((row) => `${row.step} ${row.level} ${name(row)} ${row.folded} (page ${row.page}) ${row.reshaped.join(' ')}`))}`);
	console.log(`after the night sheet switched on: ${JSON.stringify(unseen.map((row) => `${row.level} ${name(row)} ${row.folded} (page ${row.page})`))}`);
	expect(fresh).toHaveLength(3 * 4 * 6);
	expect(fresh.filter((row) => !readable(row) || row.reshaped.length > 0 || row.restyled.length > 0)).toEqual([]);
	expect(unseen).toHaveLength(3 * 6);
	expect(unseen.filter((row) => !readable(row))).toEqual([]);
	expect(errors(h)).toEqual([]);
});

const fade = 'transition: color .3s, background-color .3s';
const switchTheme = "document.documentElement.classList.toggle('theme-dark'); document.documentElement.classList.toggle('theme-light');";
const switchPanel = "document.getElementById('panel').classList.toggle('panel-dark'); document.getElementById('panel').classList.toggle('panel-light');";
const nightValues = ':root:root { --page: #0d1117; --ink: #e6edf3; --note: #3a2f05; --preset: #12372a; --tint: #10243e; }';
const prose = 'that stays as it is, so the page can be measured beside the fold. It has two sentences here.';
const plainControl = `<p id="control">A paragraph ${prose}</p>`;
const noteControl = `<p id="control" class="has-background" style="background-color: var(--note)">A callout ${prose}</p>`;

type Moment = { at: number; fold: number; page: number };

// Each frame gives the contrast of the fold and of the page's own text of the same shape, from the colors that paint them.
async function watchFade(page: Page, fold: string, act: string, ms = 1000): Promise<Moment[]> {
	const watching = page.evaluate(
		({ fold, ms }) => {
			type Rgba = [number, number, number, number];
			const parse = (color: string): Rgba => {
				const [r = 0, g = 0, b = 0, a = 1] = (color.match(/[\d.]+/g) ?? []).map(Number);
				return [r, g, b, a];
			};
			const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
			const linear = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
			const luminance = ([r, g, b]: Rgba) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
			const flatParent = (el: Element): Element | null => {
				const root = el.getRootNode();
				return el.assignedSlot ?? el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
			};
			const contrast = (el: Element) => {
				const layers: Rgba[] = [];
				for (let up: Element | null = el; up; up = flatParent(up)) {
					const color = parse(getComputedStyle(up).backgroundColor);
					if (color[3] > 0) layers.unshift(color);
					if (color[3] === 1) break;
				}
				const back = layers.reduce<Rgba>((under, layer) => over(layer, under), [255, 255, 255, 1]);
				const [ink, under] = [luminance(over(parse(getComputedStyle(el).webkitTextFillColor), back)), luminance(back)];
				return Math.round(((Math.max(ink, under) + 0.05) / (Math.min(ink, under) + 0.05)) * 100) / 100;
			};
			const [folded, control] = [document.querySelector(fold), document.getElementById('control')];
			if (!folded || !control) throw new Error('no fold or no control');
			return new Promise<Moment[]>((resolve) => {
				const moments: Moment[] = [];
				const start = performance.now();
				const tick = () => {
					moments.push({ at: Math.round(performance.now() - start), fold: contrast(folded), page: contrast(control) });
					if (performance.now() - start < ms) requestAnimationFrame(tick);
					else resolve(moments);
				};
				tick();
			});
		},
		{ fold, ms },
	);
	await page.evaluate(`(() => { ${act} })()`);
	return watching;
}

function lowOf(moments: Moment[], side: 'fold' | 'page'): { low: number; msUnder3: number; end: number } {
	let msUnder3 = 0;
	for (const [i, moment] of moments.entries()) if (i > 0 && moment[side] < 3) msUnder3 += moment.at - (moments[i - 1] as Moment).at;
	return { low: Math.min(...moments.map((moment) => moment[side])), msUnder3, end: (moments.at(-1) as Moment)[side] };
}

async function foldBeside(h: Harness, css: string, where: string, control: string, block: string, level: number): Promise<string> {
	await h.navigate(themes);
	if (css) await h.page.addStyleTag({ content: css });
	await h.page.evaluate(({ where, control }) => document.querySelector(where)?.insertAdjacentHTML('afterbegin', control), { where, control });
	await ready(h);
	await fold(h, block, level);
	return overlayOf(block);
}

for (const { name, css, where, control, block, act } of [
	{ name: 'html', css: `html { color: var(--ink); background: var(--page); ${fade} } body { color: inherit; background: transparent; }`, where: '.col', control: plainControl, block: '#plain', act: switchTheme },
	{ name: 'body', css: `body { ${fade} }`, where: '.col', control: plainControl, block: '#plain', act: switchTheme },
	{ name: "the block's own wrapper", css: `.panel { ${fade} }`, where: '#panel', control: plainControl, block: '#panel-plain', act: switchPanel },
	{ name: 'every element', css: `* { ${fade} }`, where: '.col', control: plainControl, block: '#plain', act: switchTheme },
	{ name: 'body and every paragraph with a color of its own', css: `body { ${fade} } p { color: var(--ink); ${fade} }`, where: '.col', control: plainControl, block: '#plain', act: switchTheme },
	{ name: 'body, over a background of its own', css: `body { ${fade} }`, where: '.col', control: noteControl, block: '#wp-note', act: switchTheme },
	{ name: 'every element, over a background of its own', css: `* { ${fade} }`, where: '.col', control: noteControl, block: '#wp-note', act: switchTheme },
]) {
	for (const level of [1, 2]) {
		test(`lane 16: at level ${level}, through a theme that fades on ${name}, a fold is unreadable for no longer than the page's own text and reads as well as it once the fade stops`, async ({ h }) => {
			const overlay = await foldBeside(h, css, where, control, block, level);
			for (const scheme of ['to dark', 'to light']) {
				const moments = await watchFade(h.page, overlay, act);
				const [folded, page] = [lowOf(moments, 'fold'), lowOf(moments, 'page')];
				console.log(`fade on ${name}, level ${level}, ${scheme}: fold ${JSON.stringify(folded)}, page ${JSON.stringify(page)}`);
				expect(folded.end, `${scheme}: the fold reads as the page does once the fade stops`).toBe(page.end);
				expect(folded.msUnder3, `${scheme}: the fold is under 3 to 1 no longer than the page, give or take three frames`).toBeLessThanOrEqual(page.msUnder3 + 50);
			}
			expect(errors(h)).toEqual([]);
		});
	}
}

test('lane 16: a fold over the page, of a block slotted into a shadow tree whose wrapper fades its color, reads as the text beside it', async ({ h }) => {
	await h.navigate(themes);
	await h.page.evaluate((prose) => {
		document.body.insertAdjacentHTML('afterbegin', `<div id="host"><p id="slotted">A paragraph ${prose}</p><nav id="control">Text beside it</nav></div>`);
		document.getElementById('host')?.attachShadow({ mode: 'open' }).append(
			Object.assign(document.createElement('style'), { textContent: '.inner { color: var(--ink); transition: color .3s; }' }),
			Object.assign(document.createElement('div'), { className: 'inner', innerHTML: '<slot></slot>' }),
		);
	}, prose);
	await ready(h);
	await fold(h, '#slotted', 2);
	const moments = await watchFade(h.page, overlayOf('#slotted'), switchTheme);
	console.log(`slotted: fold ${JSON.stringify(lowOf(moments, 'fold'))}, page ${JSON.stringify(lowOf(moments, 'page'))}`);
	expect(moments.filter((moment) => moment.fold !== moment.page)).toEqual([]);
	expect(lowOf(moments, 'fold').end).toBeGreaterThan(15);
});

const keyframes = '@keyframes to-dark { from { color: #1f2328; background-color: #ffffff; } to { color: #e6edf3; background-color: #0d1117; } } @keyframes to-light { from { color: #e6edf3; background-color: #0d1117; } to { color: #1f2328; background-color: #ffffff; } }';

for (const { name, fill, control, block } of [
	{ name: 'over the page', fill: '', control: plainControl, block: '#plain' },
	{ name: 'over a background of its own', fill: '', control: noteControl, block: '#wp-note' },
	{ name: 'over a background of its own, holding its last frame', fill: ' both', control: noteControl, block: '#wp-note' },
]) {
	test(`lane 16: through a theme that fades by a keyframe animation on body, ${name}, a fold reads as the page does once the fade stops`, async ({ h }) => {
		const css = `${keyframes} .theme-dark body { animation: to-dark .3s${fill}; } .theme-light body.used { animation: to-light .3s${fill}; }`;
		const overlay = await foldBeside(h, css, '.col', control, block, 2);
		await h.page.evaluate(() => document.body.classList.add('used'));
		for (const scheme of ['to dark', 'to light']) {
			const moments = await watchFade(h.page, overlay, switchTheme);
			const [folded, page] = [lowOf(moments, 'fold'), lowOf(moments, 'page')];
			console.log(`keyframes ${name}, ${scheme}: fold ${JSON.stringify(folded)}, page ${JSON.stringify(page)}`);
			expect(folded.end, `${scheme}: the fold reads as the page does once the fade stops`).toBe(page.end);
			expect(folded.msUnder3, `${scheme}: the fold is under 3 to 1 no longer than the page, give or take three frames`).toBeLessThanOrEqual(page.msUnder3 + 50);
		}
		expect(errors(h)).toEqual([]);
	});
}

const nightSheet = "document.getElementById('night').sheet.disabled = false;";
const inserted = `document.styleSheets[0].insertRule(${JSON.stringify(nightValues)});`;
const adopted = `const sheet = new CSSStyleSheet(); sheet.replaceSync(${JSON.stringify(nightValues)}); document.adoptedStyleSheets = [sheet];`;
const quietSwitches = [
	{ name: 'a script that enables a style sheet', css: '', act: nightSheet },
	{ name: 'insertRule', css: '', act: inserted },
	{ name: 'adoptedStyleSheets', css: '', act: adopted },
	{ name: 'a checkbox that :has() reads', css: 'html:has(#night-box:checked) { color-scheme: dark; --page: #0d1117; --ink: #e6edf3; }', act: "document.getElementById('night-box').checked = true;" },
];

for (const { name, css, act } of quietSwitches) {
	test(`lane 17: through ${name}, which changes no attribute, a fold over the page reads as the page does at every moment`, async ({ h }) => {
		const overlay = await foldBeside(h, css, '.col', `<input id="night-box" type="checkbox">${plainControl}`, '#plain', 2);
		const moments = await watchFade(h.page, overlay, act, 200);
		console.log(`${name}: fold ${JSON.stringify(lowOf(moments, 'fold'))}, page ${JSON.stringify(lowOf(moments, 'page'))}`);
		expect(moments.filter((moment) => moment.fold !== moment.page)).toEqual([]);
		expect(lowOf(moments, 'fold').end).toBeGreaterThan(15);
	});
}

for (const { name, act } of quietSwitches.slice(0, 3)) {
	test(`lane 17: when ${name} starts a fade, a fold over a background of its own takes the new look as the fade stops`, async ({ h }) => {
		const overlay = await foldBeside(h, `body { ${fade} }`, '.col', noteControl, '#wp-note', 2);
		const moments = await watchFade(h.page, overlay, act);
		const [folded, page] = [lowOf(moments, 'fold'), lowOf(moments, 'page')];
		console.log(`${name} with a fade: fold ${JSON.stringify(folded)}, page ${JSON.stringify(page)}`);
		expect(page.end).toBeLessThan(13);
		expect(folded.end).toBe(page.end);
	});
}

test('lane 17: when a rule cancels a fade that a style sheet started, a fold over a background of its own takes the new look', async ({ h }) => {
	const overlay = await foldBeside(h, `body { ${fade} }`, '.col', noteControl, '#wp-note', 2);
	const moments = await watchFade(h.page, overlay, `${nightSheet} setTimeout(() => document.styleSheets[0].insertRule('body { transition: none !important; }'), 100);`);
	const [folded, page] = [lowOf(moments, 'fold'), lowOf(moments, 'page')];
	console.log(`a canceled fade: fold ${JSON.stringify(folded)}, page ${JSON.stringify(page)}`);
	expect(page.end).toBeLessThan(13);
	expect(folded.end).toBe(page.end);
});

test('lane 17: when a rule cancels a keyframe fade that a style sheet started, a fold over a background of its own takes the new look', async ({ h }) => {
	const overlay = await foldBeside(h, keyframes, '.col', noteControl, '#wp-note', 2);
	const moments = await watchFade(h.page, overlay, `${nightSheet} document.styleSheets[0].insertRule('body { animation: to-dark 1s; }'); setTimeout(() => document.styleSheets[0].insertRule('body { animation: none !important; }'), 100);`);
	const [folded, page] = [lowOf(moments, 'fold'), lowOf(moments, 'page')];
	console.log(`a canceled keyframe fade: fold ${JSON.stringify(folded)}, page ${JSON.stringify(page)}`);
	expect(page.end).toBeLessThan(13);
	expect(folded.end).toBe(page.end);
});

test('lane 17: once a fade has stopped, a fold over a background of its own holds its ink and its background as one reading, so a later switch through the CSSOM leaves it readable', async ({ h }) => {
	const overlay = await foldBeside(h, `body { ${fade} }`, '.col', noteControl, '#wp-note', 2);
	await watchFade(h.page, overlay, switchTheme);
	const moments = await watchFade(h.page, overlay, "document.styleSheets[0].insertRule('body { transition: none !important; }'); document.styleSheets[0].insertRule(':root:root { --ink: #1f2328; --page: #ffffff; }');", 200);
	const folded = lowOf(moments, 'fold');
	console.log(`a later switch through the CSSOM: fold ${JSON.stringify(folded)}`);
	expect(folded.low).toBeGreaterThan(4.5);
});

test('lane 17: a fade elsewhere on the page leaves a fold over a background of its own holding its ink and its background as one reading', async ({ h }) => {
	const overlay = await foldBeside(h, '#elsewhere { transition: color 2s; } #elsewhere.moved { color: #f00; }', '.col', `<nav id="elsewhere">Text</nav>${noteControl}`, '#wp-note', 2);
	await h.page.evaluate(() => document.getElementById('elsewhere')?.classList.add('moved'));
	await h.page.evaluate(switchTheme);
	await settle(h.page);
	const moments = await watchFade(h.page, overlay, "document.styleSheets[0].insertRule(':root:root { --ink: #1f2328; --page: #ffffff; }');", 200);
	const folded = lowOf(moments, 'fold');
	console.log(`a fade elsewhere: fold ${JSON.stringify(folded)}`);
	expect(folded.low).toBeGreaterThan(4.5);
});

type Landing = { frames: number; ms: number; ink: string };

// Frames drawn after a theme changes until the fold shows it, while the page writes around the fold before and after.
function framesToLand(page: Page, overlay: string, start: 'task' | 'frame', writesBefore: number, writesAfter: number): Promise<Landing> {
	return page.evaluate(
		async ({ overlay, start, writesBefore, writesAfter }) => {
			const fold = document.querySelector(overlay) as Element;
			const col = document.querySelector('.col') as HTMLElement;
			const before = getComputedStyle(fold).webkitTextFillColor;
			const nextFrame = () => new Promise(requestAnimationFrame);
			const write = (i: number) => {
				col.style.transform = `translateY(${i % 2}px)`;
			};
			for (let i = 0; i < writesBefore; i++) {
				write(i);
				await nextFrame();
			}
			const toggle = () => {
				document.documentElement.classList.toggle('theme-dark');
				document.documentElement.classList.toggle('theme-light');
			};
			if (start === 'frame') requestAnimationFrame(toggle);
			else toggle();
			if (start === 'frame') await nextFrame();
			await Promise.resolve();
			const started = performance.now();
			let frames = 0;
			while (getComputedStyle(fold).webkitTextFillColor === before && performance.now() - started < 3000) {
				if (frames < writesAfter) write(frames);
				await nextFrame();
				frames++;
			}
			return { frames, ms: Math.round(performance.now() - started), ink: getComputedStyle(fold).webkitTextFillColor };
		},
		{ overlay, start, writesBefore, writesAfter },
	);
}

test('lane 18: a theme lands on a fold over a background of its own within one frame of settling, and at the longest wait while the page keeps writing around it', async ({ h }) => {
	const overlay = await foldBeside(h, '', '.col', noteControl, '#wp-note', 2);
	const steps: [string, 'task' | 'frame', number, number, number][] = [
		['from a task', 'task', 0, 0, 1],
		['from a frame', 'frame', 0, 0, 1],
		['just as a stream of writes stops', 'task', 30, 0, 2],
		['with writes for ten more frames', 'task', 30, 10, 12],
	];
	for (const [name, start, before, after, atMost] of steps) {
		const landing = await framesToLand(h.page, overlay, start, before, after);
		console.log(`a theme ${name}: ${JSON.stringify(landing)}`);
		expect(landing.frames, name).toBeLessThanOrEqual(atMost);
		await h.page.waitForTimeout(100);
	}
	const during = await framesToLand(h.page, overlay, 'task', 30, 10_000);
	console.log(`a theme during a stream that never stops: ${JSON.stringify(during)}`);
	expect(during.ms).toBeLessThan(400);
	expect(errors(h)).toEqual([]);
});
