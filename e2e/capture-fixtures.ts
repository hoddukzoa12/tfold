import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { startFixtureServer } from './fixture-server.ts';

const sources = [
	{ dir: 'wikipedia-black-hole', url: 'https://en.wikipedia.org/wiki/Black_hole' },
	{ dir: 'arxiv-2401.04088', url: 'https://arxiv.org/html/2401.04088v1' },
	{ dir: 'wikipedia-ko-black-hole', url: 'https://ko.wikipedia.org/wiki/%EB%B8%94%EB%9E%99%ED%99%80' },
];

const userAgent = 'tfold-fixture-capture (https://github.com/hoddukzoa12/tfold)';
const fixturesDir = path.join(import.meta.dirname, 'fixtures');

const extensions: Record<string, string> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/gif': '.gif',
	'image/webp': '.webp',
	'image/svg+xml': '.svg',
	'font/woff2': '.woff2',
	'font/woff': '.woff',
	'application/font-woff': '.woff',
	'font/ttf': '.ttf',
	'application/x-font-ttf': '.ttf',
};

async function get(url: string): Promise<Response> {
	const response = await fetch(url, { headers: { 'user-agent': userAgent } });
	if (!response.ok) throw new Error(`${response.status} ${url}`);
	return response;
}

class Assets {
	private readonly saved = new Map<string, Promise<string>>();
	private readonly dir: string;
	bytes = 0;

	constructor(dir: string) {
		this.dir = dir;
	}

	localize(url: string): Promise<string> {
		let local = this.saved.get(url);
		if (!local) {
			local = this.download(url);
			this.saved.set(url, local);
		}
		return local;
	}

	private async download(url: string): Promise<string> {
		const response = await get(url);
		const body = Buffer.from(await response.arrayBuffer());
		const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
		const extension = extensions[type] ?? (path.extname(new URL(url).pathname) || '.bin');
		const name = createHash('sha256').update(body).digest('hex').slice(0, 16) + extension;
		await mkdir(path.join(fixturesDir, this.dir, 'assets'), { recursive: true });
		await writeFile(path.join(fixturesDir, this.dir, 'assets', name), body);
		this.bytes += body.length;
		return `/${this.dir}/assets/${name}`;
	}
}

async function inlineImport(ref: string, condition: string, base: string, assets: Assets): Promise<string> {
	const href = new URL(ref, base).href;
	const layer = /^layer\(([^)]+)\)\s*(.*)$/.exec(condition);
	const mediaQuery = (layer ? (layer[2] ?? '') : condition).trim();
	if (mediaQuery.startsWith('supports(')) throw new Error(`${base} imports ${ref} with supports(), which this script does not inline`);
	let text = await inlineCss(await (await get(href)).text(), href, assets);
	if (mediaQuery) text = `@media ${mediaQuery} {\n${text}\n}`;
	if (layer) text = `@layer ${layer[1]} {\n${text}\n}`;
	return text;
}

async function inlineCss(css: string, base: string, assets: Assets): Promise<string> {
	const imports: string[] = [];
	const importPattern = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/g;
	for (const [, , ref = '', condition = ''] of css.matchAll(importPattern)) {
		imports.push(await inlineImport(ref, condition.trim(), base, assets));
	}
	let index = 0;
	const withPlaceholders = css
		.replace(importPattern, () => `/*tfold-import-${index++}*/`)
		.replace(/(@font-face\s*\{[^}]*?\bsrc\s*:\s*)([^;}]*)/g, (_whole, head: string, list: string) => {
			const first = list.split(/,(?=\s*(?:url|local)\()/).find((entry) => entry.trim().startsWith('url('));
			return head + (first ?? list).trim();
		});
	const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
	const local = new Map<string, string>();
	for (const [, , ref = ''] of withPlaceholders.matchAll(urlPattern)) {
		if (ref.startsWith('data:') || ref.startsWith('#') || local.has(ref)) continue;
		local.set(ref, await assets.localize(new URL(ref, base).href));
	}
	return withPlaceholders
		.replace(urlPattern, (whole, _quote, ref: string) => {
			const replacement = local.get(ref);
			return replacement ? `url("${replacement}")` : whole;
		})
		.replace(/\/\*tfold-import-(\d+)\*\//g, (_whole, n: string) => imports[Number(n)] ?? '');
}

type CssSource = { href: string } | { text: string };

async function sanitize(page: Page): Promise<{ css: CssSource[]; media: string[] }> {
	return page.evaluate(() => {
		const drop = [
			'script',
			'noscript',
			'iframe',
			'object',
			'embed',
			'base',
			'meta[http-equiv]',
			'picture > source',
			'video > source',
			'video > track',
			'audio',
			'link:not([rel~="stylesheet"])',
			'link[href^="https://use.typekit.net/"]',
		];
		for (const element of document.querySelectorAll(drop.join(', '))) element.remove();
		for (const element of document.querySelectorAll('*')) {
			for (const attribute of [...element.attributes]) {
				if (attribute.name.startsWith('on')) element.removeAttribute(attribute.name);
			}
		}
		for (const anchor of document.querySelectorAll('a[href]')) {
			if (anchor instanceof HTMLAnchorElement) anchor.setAttribute('href', anchor.href);
		}
		for (const form of document.querySelectorAll('form')) form.setAttribute('action', form.action);
		const css: CssSource[] = [];
		for (const element of document.querySelectorAll('link[rel~="stylesheet"], style, [style*="url("]')) {
			element.setAttribute('data-capture', String(css.length));
			if (element instanceof HTMLLinkElement) css.push({ href: element.href });
			else if (element instanceof HTMLStyleElement) css.push({ text: element.textContent });
			else css.push({ text: element.getAttribute('style') ?? '' });
		}
		// Logos and photos keep their owners' rights, so a page saves only its formulas and its paper's figures. A sized picture becomes a gray box, which keeps the layout.
		const grayBox = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='100%25' height='100%25' fill='%23ccc'/%3E%3C/svg%3E";
		for (const image of document.querySelectorAll('img')) {
			if (/math|ltx_graphics/.test(image.className) && image.alt !== '[Uncaptioned image]') continue;
			if (image.getAttribute('width') && image.getAttribute('height')) image.setAttribute('src', grayBox);
			else image.remove();
		}
		const media: string[] = [];
		for (const image of document.querySelectorAll('img')) {
			image.removeAttribute('srcset');
			image.removeAttribute('sizes');
			image.setAttribute('src', image.src);
			media.push(image.src);
		}
		for (const video of document.querySelectorAll('video')) {
			video.removeAttribute('src');
			video.removeAttribute('poster');
			video.setAttribute('preload', 'none');
		}
		return { css, media };
	});
}

async function capture(source: (typeof sources)[number]): Promise<void> {
	await rm(path.join(fixturesDir, source.dir), { recursive: true, force: true });
	const assets = new Assets(source.dir);
	const browser = await chromium.launch();
	const page = await browser.newPage({ javaScriptEnabled: false, userAgent });
	await page.goto(source.url, { waitUntil: 'load' });
	const finalUrl = page.url();
	const found = await sanitize(page);
	const css: string[] = [];
	for (const item of found.css) {
		css.push('href' in item ? await inlineCss(await (await get(item.href)).text(), item.href, assets) : await inlineCss(item.text, finalUrl, assets));
	}
	const wikisourceMark = /\.cs1-ws-icon a\{background:url\([^)]*\)[^}]*\}/g;
	for (const [index, text] of css.entries()) css[index] = text.replace(wikisourceMark, '');
	const media: Record<string, string> = {};
	for (const url of new Set(found.media)) {
		if (!url.startsWith('data:')) media[url] = await assets.localize(url);
	}
	const html = await page.evaluate(
		({ css, media, finalUrl }) => {
			for (const element of document.querySelectorAll('[data-capture]')) {
				const text = css[Number(element.getAttribute('data-capture'))] ?? '';
				element.removeAttribute('data-capture');
				if (element instanceof HTMLLinkElement) {
					const style = document.createElement('style');
					if (element.media) style.setAttribute('media', element.media);
					style.textContent = text;
					element.replaceWith(style);
				} else if (element instanceof HTMLStyleElement) {
					element.textContent = text;
				} else {
					element.setAttribute('style', text);
				}
			}
			for (const image of document.querySelectorAll('img')) {
				const local = media[image.getAttribute('src') ?? ''];
				if (local) image.setAttribute('src', local);
			}
			document.head.prepend(document.createComment(` captured from ${finalUrl} on ${new Date().toISOString()} `));
			return `<!DOCTYPE html>\n${document.documentElement.outerHTML}\n`;
		},
		{ css, media, finalUrl },
	);
	await writeFile(path.join(fixturesDir, source.dir, 'index.html'), html);
	await browser.close();
	console.log(`${source.dir}: ${finalUrl}, html ${html.length} bytes, assets ${assets.bytes} bytes`);
}

async function offOriginRequests(dir: string): Promise<string[]> {
	const server = await startFixtureServer();
	const browser = await chromium.launch();
	const page = await browser.newPage();
	const leaks: string[] = [];
	page.on('request', (request) => {
		if (!request.url().startsWith(server.baseURL) && !request.url().startsWith('data:')) leaks.push(request.url());
	});
	await page.route((url) => !url.href.startsWith(server.baseURL), (route) => route.abort());
	await page.goto(`${server.baseURL}/${dir}/`, { waitUntil: 'load' });
	await browser.close();
	await server.close();
	return leaks;
}

const only = process.argv.slice(2);
for (const source of sources.filter((candidate) => only.length === 0 || only.includes(candidate.dir))) {
	await capture(source);
	const leaks = await offOriginRequests(source.dir);
	if (leaks.length > 0) throw new Error(`${source.dir} still requests ${leaks.length} off-origin URLs:\n${leaks.join('\n')}`);
}
