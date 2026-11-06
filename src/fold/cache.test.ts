import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../e2e/fixture-server.ts';
import type * as Cache from './cache.ts';
import type { Fold } from './types.ts';

type Probe = { parts: Cache.CacheKeyParts; write?: Fold };

let browser: Browser;
let server: FixtureServer;
let page: Page;

beforeAll(async () => {
	const bundle = await build({
		entryPoints: [path.join(import.meta.dirname, 'cache.ts')],
		bundle: true,
		format: 'iife',
		globalName: 'tfoldCache',
		target: 'chrome120',
		write: false,
	});
	[browser, server] = await Promise.all([chromium.launch(), startFixtureServer()]);
	page = await browser.newPage();
	await page.goto(new URL('/react/', server.baseURL).href);
	await page.addScriptTag({ content: bundle.outputFiles[0]?.text ?? '' });
});

afterAll(async () => {
	await browser.close();
	await server.close();
});

function probe({ parts, write }: Probe): Promise<Fold | null> {
	return page.evaluate(
		async ({ parts, write }) => {
			const cache = (globalThis as unknown as { tfoldCache: typeof Cache }).tfoldCache;
			const key = await cache.cacheKey(parts);
			if (write) await cache.writeCache(key, write);
			return (await cache.readCache(key)) ?? null;
		},
		{ parts, write },
	);
}

const parts: Cache.CacheKeyParts = {
	url: 'https://en.wikipedia.org/wiki/Black_hole',
	sentences: ['A black hole traps light.', 'Its horizon is the boundary.'],
	provider: 'openrouter',
	baseUrl: 'https://openrouter.ai/api/v1',
	model: 'deepseek/deepseek-v4.1-flash-1017',
	promptVersion: 1,
	translateTo: undefined,
};
const fold: Fold = { sentences: parts.sentences, brief: [1], key: 'A black hole traps light. Nothing escapes.', takeaway: 'A black hole traps light' };

test('a paragraph that was never folded is a miss', async () => {
	expect(await probe({ parts: { ...parts, url: 'https://example.org/never' } })).toBeNull();
});

test('a written paragraph is a hit with the same fold', async () => {
	expect(await probe({ parts, write: fold })).toEqual(fold);
	expect(await probe({ parts })).toEqual(fold);
});

test('a new prompt version, another provider, another endpoint, another model, another page, changed text or another output language is a miss', async () => {
	await probe({ parts, write: fold });
	expect(await probe({ parts: { ...parts, translateTo: 'ko' } })).toBeNull();
	expect(await probe({ parts: { ...parts, promptVersion: 2 } })).toBeNull();
	expect(await probe({ parts: { ...parts, provider: 'opengateway' } })).toBeNull();
	expect(await probe({ parts: { ...parts, baseUrl: 'http://127.0.0.1:8080/v1' } })).toBeNull();
	expect(await probe({ parts: { ...parts, model: 'another/model' } })).toBeNull();
	expect(await probe({ parts: { ...parts, url: 'https://en.wikipedia.org/wiki/Neutron_star' } })).toBeNull();
	expect(await probe({ parts: { ...parts, sentences: ['A black hole traps light.'] } })).toBeNull();
	expect(await probe({ parts })).toEqual(fold);
});
