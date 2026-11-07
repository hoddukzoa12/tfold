import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const builds = {
	open: { edition: 'open', dev: false, outdir: 'dist' },
	store: { edition: 'store', dev: false, outdir: 'dist-store' },
	// The development tools switch between the store edition's accounts, so they sit on top of it.
	dev: { edition: 'store', dev: true, outdir: 'dist-dev' },
} satisfies Record<string, { edition: Edition; dev: boolean; outdir: string }>;

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { store: { type: 'boolean', default: false }, dev: { type: 'boolean', default: false }, outdir: { type: 'string' } } });
const { edition, dev, outdir: defaultOutdir } = builds[values.dev ? 'dev' : values.store ? 'store' : 'open'];
const outdir = path.resolve(root, values.outdir ?? defaultOutdir);
const src = (file: string) => path.join(root, 'src', file);

// The pages and the stylesheet mark what only the store edition has with <!-- store --> or /* store */ on lines of their own.
const storeBlock = /^\s*(?:<!-- store -->|\/\* store \*\/)\n[\s\S]*?^\s*(?:<!-- \/store -->|\/\* \/store \*\/)\n/gm;
const storeMark = /^\s*(?:<!-- \/?store -->|\/\* \/?store \*\/)\n/gm;
const forEdition = (text: string) => text.replace(edition === 'store' ? storeMark : storeBlock, '');

await rm(outdir, { recursive: true, force: true });
await build({
	entryPoints: ['content/index.ts', 'background/index.ts', 'options/options.ts', 'popup/popup.ts'].map(src),
	bundle: true,
	format: 'iife',
	target: 'chrome120',
	outbase: src(''),
	outdir,
	define: { TFOLD_EDITION: JSON.stringify(edition), TFOLD_DEV: String(dev) },
	minifySyntax: true,
	// Without this, each Korean letter costs 6 bytes as an escape instead of 3.
	charset: 'utf8',
	logLevel: 'warning',
});
for (const file of ['manifest.json', 'options/options.html', 'popup/popup.html', '_locales', 'icons', 'ui']) {
	await cp(src(file), path.join(outdir, file), { recursive: true, filter: (from) => edition === 'store' || !from.endsWith('google.svg') });
}
for (const file of ['options/options.html', 'popup/popup.html', 'ui/tfold.css']) {
	const copy = path.join(outdir, file);
	await writeFile(copy, forEdition(await readFile(copy, 'utf8')));
}
for (const file of ['tfold-wordmark.svg', 'tfold-mark.svg']) await cp(path.join(root, 'assets', 'brand', file), path.join(outdir, 'ui', file));
for (const file of ['LICENSE', 'NOTICE', 'LICENSES']) await cp(path.join(root, file), path.join(outdir, file), { recursive: true });
