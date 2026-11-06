import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Locator } from '@playwright/test';
import { editionDirs, fixtures, launch, type Harness, type LogEntry } from '../harness.ts';
import { expect, test } from '../lane.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const textfoldNotice = path.join(repoRoot, 'e2e', 'fixtures', 'textfold-NOTICE');
const firstWikiParagraph = '#mw-content-text section > p:not(.mw-empty-elt)';

type ExtensionErrors = { manifestErrors: unknown[]; runtimeErrors: { message: string }[]; installWarnings: unknown[] };
type ExtensionsPage = {
	chrome: {
		developerPrivate: {
			getExtensionInfo(id: string): Promise<ExtensionErrors>;
			updateExtensionConfiguration(update: { extensionId: string; errorCollection: boolean }): Promise<void>;
			reload(id: string, options: { failQuietly: boolean }): Promise<void>;
		};
	};
};

async function fresh(slug: string): Promise<string> {
	const file = path.join(repoRoot, 'e2e', 'out', 'p1', `${slug}.png`);
	await rm(file, { force: true });
	return file;
}

const count = (h: Harness, source: LogEntry['source'], text: string) =>
	h.logs.filter((entry) => entry.source === source && entry.text === text).length;

const errors = (h: Harness) => h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror');

async function expectContentReadyOnce(h: Harness): Promise<void> {
	await expect.poll(() => count(h, 'page', 'content ready')).toBe(1);
	await h.page.waitForTimeout(500);
	expect(count(h, 'page', 'content ready')).toBe(1);
}

async function reloadWithErrorCollection(h: Harness): Promise<void> {
	await h.navigate('chrome://extensions/');
	const restarted = h.context.waitForEvent('serviceworker');
	await h.page.evaluate(async (id) => {
		const { developerPrivate } = (globalThis as unknown as ExtensionsPage).chrome;
		await developerPrivate.updateExtensionConfiguration({ extensionId: id, errorCollection: true });
		await developerPrivate.reload(id, { failQuietly: true });
	}, h.extensionId);
	await restarted;
}

async function readCard(h: Harness): Promise<{ card: Locator; errors: ExtensionErrors }> {
	await h.navigate('chrome://extensions/');
	const card = h.page.locator(`extensions-item#${h.extensionId}`);
	await expect(card).toBeVisible();
	const errors = await h.page.evaluate(async (id) => {
		const info = await (globalThis as unknown as ExtensionsPage).chrome.developerPrivate.getExtensionInfo(id);
		return {
			manifestErrors: info.manifestErrors,
			runtimeErrors: info.runtimeErrors.map(({ message }) => ({ message })),
			installWarnings: info.installWarnings,
		};
	}, h.extensionId);
	return { card, errors };
}

function run(command: string, ...args: string[]): { status: number | null; output: string } {
	const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
	return { status: result.status, output: `$ ${[command, ...args].join(' ')}\n${result.stdout}${result.stderr}exit ${result.status}\n` };
}

async function hashTree(dir: string): Promise<string> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
		.sort();
	const lines = await Promise.all(
		files.map(async (file) => `${createHash('sha256').update(await readFile(path.join(dir, file))).digest('hex')}  ${file}`),
	);
	return lines.join('\n');
}

test('lane 1: the harness boots the extension and loads the Wikipedia fixture', async ({ h }) => {
	const png = await fresh('p1-boot');
	expect(h.extensionId).toMatch(/^[a-p]{32}$/);
	await h.navigate(fixtures.wiki);
	await expect(h.page.locator('#firstHeading')).toHaveText('Black hole');
	await h.page.screenshot({ path: png });
});

test('lane 2: the Wikipedia fixture logs content ready once', async ({ h }) => {
	const png = await fresh('p1-wiki');
	await h.navigate(fixtures.wiki);
	await expectContentReadyOnce(h);
	await h.page.screenshot({ path: png });
});

test('lane 3: the arXiv fixture logs content ready once and no error', async ({ h }) => {
	const png = await fresh('p1-arxiv');
	await h.navigate(fixtures.arxiv);
	await expectContentReadyOnce(h);
	await h.page.screenshot({ path: png });
	expect(errors(h)).toEqual([]);
});

test('lane 4: the React fixture counter reads 2 after two clicks', async ({ h }) => {
	const png = await fresh('p1-react');
	await h.navigate(fixtures.react);
	await expect(h.page.locator('#counter')).toHaveText('0');
	await h.click('#counter');
	await h.click('#counter');
	await expect(h.page.locator('#counter')).toHaveText('2');
	await expectContentReadyOnce(h);
	await h.page.screenshot({ path: png });
	expect(errors(h)).toEqual([]);
});

test('lane 5: the service worker logs background ready', async ({ h }) => {
	const png = await fresh('p1-sw');
	await expect.poll(() => count(h, 'worker', 'background ready')).toBe(1);
	expect(await h.worker.evaluate(() => location.href)).toBe(h.worker.url());
	const workerLog = h.logs.filter((entry) => entry.source === 'worker').map((entry) => `[${entry.type}] ${entry.text}`);
	await h.showText(`service worker ${h.worker.url()}`, workerLog.join('\n'));
	await h.page.screenshot({ path: png });
});

test('lane 6: foldAt over the first Wikipedia paragraph reaches a page listener with ctrlKey', async ({ h }) => {
	const png = await fresh('p1-fold');
	await h.navigate(fixtures.wiki);
	await h.page.evaluate((selector) => {
		const paragraph = document.querySelector(selector);
		addEventListener(
			'wheel',
			(event) => {
				const block = event.target instanceof Element ? event.target.closest('p') : null;
				console.log(`wheel ctrlKey ${event.ctrlKey} ${block?.tagName ?? 'none'} ${block === paragraph ? 'first paragraph' : 'other'}`);
			},
			{ passive: false },
		);
	}, firstWikiParagraph);
	const point = await h.pointAt(firstWikiParagraph);
	await h.foldAt(point.x, point.y, 1);
	const wheelLogs = () => h.logs.filter((entry) => entry.text.startsWith('wheel ')).map((entry) => entry.text);
	await expect.poll(() => wheelLogs().length).toBeGreaterThan(0);
	await h.page.evaluate(
		({ selector, x, y }) => {
			document.querySelector<HTMLElement>(selector)?.style.setProperty('outline', '3px solid #d33');
			const dot = document.body.appendChild(document.createElement('div'));
			dot.style.cssText = `position:fixed;left:${x - 8}px;top:${y - 8}px;width:16px;height:16px;border-radius:50%;background:#d33;z-index:2147483647`;
		},
		{ selector: firstWikiParagraph, ...point },
	);
	await h.page.screenshot({ path: png });
	expect(new Set(wheelLogs())).toEqual(new Set(['wheel ctrlKey true P first paragraph']));
});

test('lane 7: two builds of each edition produce the same tree', async ({ h }) => {
	test.setTimeout(120_000);
	const png = await fresh('p1-build');
	const shown: string[] = [];
	for (const [script, dir] of [['build', editionDirs.open], ['build:store', editionDirs.store]] as const) {
		const first = run('npm', 'run', script);
		const firstTree = await hashTree(dir);
		const second = run('npm', 'run', script);
		const secondTree = await hashTree(dir);
		shown.push(`${first.output}${firstTree}\n\n${second.output}${secondTree}`);
		expect([first.status, second.status], script).toEqual([0, 0]);
		expect(secondTree, script).toBe(firstTree);
	}
	await h.showText('each build, twice', shown.join('\n\n'));
	await h.page.screenshot({ path: png, fullPage: true });
});

test('lane 8: chrome://extensions shows the tfold card with no errors', async ({ h }) => {
	const png = await fresh('p1-extensions');
	await reloadWithErrorCollection(h);
	await h.navigate(fixtures.wiki);
	await expectContentReadyOnce(h);
	const { card, errors } = await readCard(h);
	await h.page.screenshot({ path: png });
	expect(errors).toEqual({ manifestErrors: [], runtimeErrors: [], installWarnings: [] });
	await expect(card.locator('#errors-button')).toBeHidden();
});

test('lane 8 guard: the card shows errors planted in a service worker and a content script', async ({ headless }) => {
	const png = await fresh('p1-extensions-planted');
	const planted = await mkdtemp(path.join(tmpdir(), 'tfold-planted-'));
	const manifest = {
		manifest_version: 3,
		name: 'tfold planted error',
		version: '0.0.0',
		background: { service_worker: 'background.js' },
		content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }],
	};
	await writeFile(path.join(planted, 'manifest.json'), JSON.stringify(manifest));
	await writeFile(path.join(planted, 'background.js'), "setTimeout(() => { throw new Error('planted in the service worker'); }, 0);\n");
	await writeFile(path.join(planted, 'content.js'), "throw new Error('planted in the content script');\n");
	const h = await launch({ headless }, planted);
	try {
		await reloadWithErrorCollection(h);
		await h.navigate(fixtures.wiki);
		const messages = async () => (await readCard(h)).errors.runtimeErrors.map(({ message }) => message).toSorted();
		await expect
			.poll(messages)
			.toEqual(['Uncaught Error: planted in the content script', 'Uncaught Error: planted in the service worker']);
		await h.page.screenshot({ path: png });
		await expect(h.page.locator(`extensions-item#${h.extensionId} #errors-button`)).toBeVisible();
	} finally {
		await h.close();
		await rm(planted, { recursive: true, force: true });
	}
});

test('offline guard: launch aborts and reports requests from the page and the service worker that leave the fixture server', async ({
	headless,
}) => {
	const h = await launch({ headless });
	await h.navigate(fixtures.wiki);
	const fromPage = await h.page.evaluate(() => fetch('https://example.com/from-page', { mode: 'no-cors' }).then(() => 'answered', () => 'aborted'));
	const fromWorker = await h.worker.evaluate(() => fetch('https://example.com/from-worker', { mode: 'no-cors' }).then(() => 'answered', () => 'aborted'));
	expect({ fromPage, fromWorker }).toEqual({ fromPage: 'aborted', fromWorker: 'aborted' });
	expect(h.blockedRequests).toEqual(['https://example.com/from-page', 'https://example.com/from-worker']);
	await expect(h.close()).rejects.toThrow('requests left the fixture server and were aborted');
});

test('lane 9: lint and typecheck exit 0', async ({ h }) => {
	test.setTimeout(180_000);
	const png = await fresh('p1-lint');
	const lint = run('npm', 'run', 'lint');
	const typecheck = run('npm', 'run', 'typecheck');
	await h.showText('npm run lint and npm run typecheck', `${lint.output}\n${typecheck.output}`);
	await h.page.screenshot({ path: png, fullPage: true });
	expect([lint.status, typecheck.status]).toEqual([0, 0]);
});

test("lane 10: NOTICE carries textfold's NOTICE verbatim and LICENSE is AGPL-3.0 and the Apache-2.0 text ships for TextFold-derived files", async ({ h }) => {
	const png = await fresh('p1-notice');
	const upstreamNotice = (await readFile(textfoldNotice, 'utf8')).trimEnd();
	const notice = await readFile(path.join(repoRoot, 'NOTICE'), 'utf8');
	const license = await readFile(path.join(repoRoot, 'LICENSE'), 'utf8');
	const licenseHead = license.split('\n').slice(0, 4).join('\n');
	await h.showText('NOTICE, then the first lines of LICENSE', `${notice}\n----- LICENSE -----\n${licenseHead}`);
	await h.page.screenshot({ path: png, fullPage: true });
	expect(notice).toContain(upstreamNotice);
	expect(license).toMatch(/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
	expect(license).toContain('END OF TERMS AND CONDITIONS');
	const apache = await readFile(path.join(repoRoot, 'LICENSES', 'Apache-2.0.txt'), 'utf8');
	expect(apache).toMatch(/Apache License\s+Version 2\.0, January 2004/);
});
