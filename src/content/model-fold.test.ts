import path from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { replyDeadlineMs } from '../messages.ts';
import { en } from '../strings/en.ts';

type Tf = { __tfold: { readBlocks(): { id: string }[]; setLevel(id: string, level: number): void } };
type Reply = 'never' | 'empty' | 'good';

let browser: Browser;
let contentScript: string;

beforeAll(async () => {
	const bundle = build({ entryPoints: [path.join(import.meta.dirname, 'index.ts')], bundle: true, format: 'iife', target: 'chrome120', define: { TFOLD_EDITION: '"store"', TFOLD_DEV: 'false' }, write: false });
	[browser, contentScript] = await Promise.all([chromium.launch(), bundle.then((result) => result.outputFiles[0]?.text ?? '')]);
});

afterAll(async () => {
	await browser.close();
});

type Shown = { fold: string | null; badge: string | null; text: string | null };

const paragraph = 'A paragraph with enough words to fold. It waits for a fold reply from the extension.';
const modelFold = { sentences: ['A paragraph with enough words to fold.', 'It waits for a fold reply from the extension.'], brief: [1], key: 'A fold reply.', takeaway: 'A reply.' };

async function shownAt(reply: Reply, times: number[]): Promise<Shown[]> {
	const page = await browser.newPage({ reducedMotion: 'reduce' });
	await page.clock.install({ time: 0 });
	await page.clock.pauseAt(1000);
	await page.setContent(`<main><p>${paragraph}</p></main>`);
	await page.evaluate(
		([reply, fold]) => {
			const answer = reply === 'good' ? { ok: true, folds: [fold] } : undefined;
			const sendMessage = (message: { type: string }) =>
				message.type === 'fold' && reply === 'never' ? new Promise(() => undefined) : Promise.resolve(message.type === 'fold' ? answer : undefined);
			Object.assign(globalThis, { chrome: { runtime: { sendMessage, onMessage: { addListener() {} } }, i18n: { getUILanguage: () => 'en' }, storage: { sync: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } } } });
		},
		[reply, modelFold] as const,
	);
	await page.addScriptTag({ content: contentScript });
	await page.evaluate(() => {
		const tf = (globalThis as unknown as Tf).__tfold;
		const [block] = tf.readBlocks();
		if (!block) throw new Error('no block');
		tf.setLevel(block.id, 1);
	});
	const seen: Shown[] = [];
	let now = 0;
	for (const at of times) {
		await page.clock.runFor(at - now);
		now = at;
		seen.push(
			await page
				.locator('[data-tfold-overlay]')
				.evaluate((el) => ({ fold: el.getAttribute('data-tf-fold'), badge: el.getAttribute('data-tf-badge'), text: el.textContent })),
		);
	}
	await page.close();
	return seen;
}

test('a fold reply that never comes shows the network badge at the deadline, and an empty reply still shows the failed badge', async () => {
	const badges = async (reply: Reply) => (await shownAt(reply, [replyDeadlineMs - 1, replyDeadlineMs])).map(({ badge }) => badge);
	expect(await badges('never')).toEqual([null, en.badgeNetwork]);
	expect(await badges('empty')).toEqual([en.badgeFailed, en.badgeFailed]);
});

test('a good fold reply shows the model fold at once, without the wait that a failed send gets', async () => {
	expect(await shownAt('good', [1])).toEqual([{ fold: 'model', badge: null, text: 'It waits for a fold reply from the extension.' }]);
});
