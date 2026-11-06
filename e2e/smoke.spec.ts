import { fixtures } from './harness.ts';
import { expect, test } from './lane.ts';

test('smoke: the content script runs on the Wikipedia fixture', async ({ h }) => {
	await h.navigate(fixtures.wiki);
	await expect.poll(() => h.logs.some((entry) => entry.source === 'page' && entry.text === 'content ready')).toBe(true);
	for (const entry of h.logs.filter((entry) => entry.source === 'page')) console.log(`page console: ${entry.text}`);
	expect(Array.isArray(await h.readBlocks())).toBe(true);
});
