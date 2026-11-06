import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const brand = (file: string) => readFile(path.join(root, 'assets', 'brand', file), 'utf8');
const outDir = path.join(root, 'src', 'icons');
const [mark, mark16] = await Promise.all([brand('tfold-mark.svg'), brand('tfold-mark-16.svg')]);

// The 16 px mark has thicker strokes and a larger monogram, so the diagonal and the open ring survive the downscale.
// The Chrome Web Store asks for 96 px of artwork inside the 128 px icon, so the largest size keeps 16 px of clear space.
const sizes = [
	{ size: 16, art: 16, svg: mark16 },
	{ size: 32, art: 32, svg: mark },
	{ size: 48, art: 48, svg: mark },
	{ size: 128, art: 96, svg: mark },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
	const page = await browser.newPage({ deviceScaleFactor: 1 });
	for (const { size, art, svg } of sizes) {
		await page.setViewportSize({ width: size, height: size });
		await page.setContent(
			`<style>html,body{margin:0;background:transparent}div{width:${size}px;height:${size}px;display:grid;place-items:center}svg{width:${art}px;height:${art}px;display:block}</style><div>${svg}</div>`,
		);
		const file = path.join(outDir, `icon-${size}.png`);
		await page.locator('div').screenshot({ path: file, omitBackground: true });
		console.log(`wrote ${path.relative(root, file)}`);
	}
} finally {
	await browser.close();
}
