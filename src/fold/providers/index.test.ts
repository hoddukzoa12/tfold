import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { FoldRequest } from '../prompt.ts';
import { chosenId, foldWith, parseProvider, parseSettings, routeOf, storedSettings, type ProviderSettings, type Route } from './index.ts';

type Recorded = { request: FoldRequest; response: unknown };

const recorded = JSON.parse(await readFile(path.join(import.meta.dirname, 'openrouter-response.json'), 'utf8')) as Recorded;

afterEach(() => vi.unstubAllGlobals());

const settings = (keys: { opengateway?: string; openrouter?: string }, chosen?: 'opengateway' | 'openrouter'): ProviderSettings =>
	parseSettings({ providers: { chosen, opengateway: { apiKey: keys.opengateway }, openrouter: { apiKey: keys.openrouter } } });

test('a setting saved before presets becomes the chosen OpenRouter provider with its key, model and endpoint', () => {
	const legacy = { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1/', apiKey: ' sk-or-v1-old ', model: 'another/model' };
	const migrated = parseSettings({ provider: legacy });
	expect(migrated.chosen).toBe('openrouter');
	expect(migrated.providers.openrouter).toEqual({
		kind: 'openai-compatible',
		id: 'openrouter',
		baseUrl: 'http://127.0.0.1:8080/v1',
		apiKey: 'sk-or-v1-old',
		model: 'another/model',
	});
	expect(migrated.providers.opengateway).toEqual(parseProvider('opengateway', undefined));
	expect(chosenId(parseSettings({ provider: { apiKey: 'sk-or-v1-old' } }))).toBe('openrouter');
});

test('a setting saved before presets with its key removed carries no choice, so a later OpenGateway key picks OpenGateway', () => {
	const removed = parseSettings({ provider: { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'deepseek/deepseek-v4.1-flash-1017' } });
	expect(removed.chosen).toBeUndefined();
	const saved = parseSettings({ providers: { ...storedSettings(removed), opengateway: { apiKey: 'og' } } });
	expect(routeOf(saved)?.first.id).toBe('opengateway');
});

test('a new setting wins over one saved before presets', () => {
	const both = parseSettings({ providers: { chosen: 'opengateway', opengateway: { apiKey: 'og' } }, provider: { apiKey: 'sk-or-v1-old' } });
	expect(both.chosen).toBe('opengateway');
	expect(both.providers.openrouter.apiKey).toBe('');
});

test('an empty or malformed setting gives both presets with no key and no choice', () => {
	for (const raw of [{}, { providers: null }, { providers: 'x' }, { providers: { chosen: 'mistral', openrouter: 5 } }]) {
		const parsed = parseSettings(raw);
		expect(parsed.chosen).toBeUndefined();
		expect(parsed.providers.openrouter).toEqual({
			kind: 'openai-compatible',
			id: 'openrouter',
			baseUrl: 'https://openrouter.ai/api/v1',
			apiKey: '',
			model: 'deepseek/deepseek-v4.1-flash-1017',
		});
		expect(parsed.providers.opengateway).toEqual({
			kind: 'openai-compatible',
			id: 'opengateway',
			baseUrl: 'https://apis.opengateway.ai/v1',
			apiKey: '',
			model: 'deepseek/deepseek-v4.1-flash-ultrafast',
		});
	}
});

test.each([
	{ reader: 'nothing chosen and no keys', keys: {}, chosen: undefined, folds: 'opengateway' },
	{ reader: 'nothing chosen and only an OpenRouter key', keys: { openrouter: 'or' }, chosen: undefined, folds: 'openrouter' },
	{ reader: 'nothing chosen and an OpenGateway key', keys: { opengateway: 'og' }, chosen: undefined, folds: 'opengateway' },
	{ reader: 'nothing chosen and both keys', keys: { opengateway: 'og', openrouter: 'or' }, chosen: undefined, folds: 'opengateway' },
	{ reader: 'OpenRouter chosen with both keys', keys: { opengateway: 'og', openrouter: 'or' }, chosen: 'openrouter', folds: 'openrouter' },
	{ reader: 'OpenRouter chosen and no keys', keys: {}, chosen: 'openrouter', folds: 'openrouter' },
	{ reader: 'OpenGateway chosen and only an OpenRouter key', keys: { openrouter: 'or' }, chosen: 'opengateway', folds: 'opengateway' },
] as const)('a reader with $reader folds with $folds', ({ keys, chosen, folds }) => {
	expect(chosenId(settings(keys, chosen))).toBe(folds);
	expect(chosenId(parseSettings({ providers: storedSettings(settings(keys, chosen)) }))).toBe(folds);
});

test('the route starts with the chosen provider, falls back only to another provider with a key, and is empty when the chosen one has no key', () => {
	const ids = (route: Route | undefined) => route && [route.first.id, route.fallback?.id];
	expect(ids(routeOf(settings({})))).toBeUndefined();
	expect(ids(routeOf(settings({ openrouter: 'or' }, 'opengateway')))).toBeUndefined();
	expect(ids(routeOf(settings({ opengateway: 'og' })))).toEqual(['opengateway', undefined]);
	expect(ids(routeOf(settings({ openrouter: 'or' })))).toEqual(['openrouter', undefined]);
	expect(ids(routeOf(settings({ opengateway: 'og', openrouter: 'or' })))).toEqual(['opengateway', 'openrouter']);
	expect(ids(routeOf(settings({ opengateway: 'og', openrouter: 'or' }, 'openrouter')))).toEqual(['openrouter', 'opengateway']);
});

test('storage keeps the choice, the keys and only the models and endpoints that differ from the preset, and reads back the same', () => {
	const custom = parseSettings({
		providers: { chosen: 'openrouter', openrouter: { apiKey: 'or', model: 'another/model', baseUrl: 'http://127.0.0.1:9/v1' }, opengateway: { apiKey: 'og' } },
	});
	const stored = storedSettings(custom);
	expect(stored).toEqual({
		chosen: 'openrouter',
		opengateway: { apiKey: 'og' },
		openrouter: { apiKey: 'or', model: 'another/model', baseUrl: 'http://127.0.0.1:9/v1' },
	});
	expect(parseSettings({ providers: stored })).toEqual(custom);
	expect(storedSettings(parseSettings({ provider: { apiKey: 'or', model: 'deepseek/deepseek-v4.1-flash-1017', baseUrl: 'https://openrouter.ai/api/v1' } }))).toEqual({
		chosen: 'openrouter',
		opengateway: { apiKey: '' },
		openrouter: { apiKey: 'or' },
	});
	expect(storedSettings(settings({ opengateway: 'og' }))).not.toHaveProperty('chosen');
});

const both: Route = {
	first: parseProvider('opengateway', { apiKey: 'og', baseUrl: 'http://first.test/v1' }),
	fallback: parseProvider('openrouter', { apiKey: 'or', baseUrl: 'http://second.test/v1' }),
};
const fast = { totalMs: 400, firstTryMs: 100 };

type Reply = number | 'answer' | 'hang' | 'refuse' | 'break' | 'empty' | 'schema';

const withContent = (content: string) => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });

function serve(replies: Record<string, Reply>): string[] {
	const hosts: string[] = [];
	vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
		const host = new URL(url).host;
		hosts.push(host);
		const reply = replies[host];
		if (reply === 'answer') return Promise.resolve(Response.json(recorded.response));
		if (reply === 'refuse') return Promise.reject(new TypeError('Failed to fetch'));
		if (reply === 'break') return Promise.resolve(new Response(new ReadableStream({ pull: (controller) => controller.error(new TypeError('network error')) })));
		if (reply === 'empty') return Promise.resolve(withContent(''));
		if (reply === 'schema') return Promise.resolve(withContent('{"units": []}'));
		if (reply === 'hang') return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
		return Promise.resolve(new Response('{}', { status: reply }));
	});
	return hosts;
}

const outcome = (attempts: Awaited<ReturnType<typeof foldWith>>) =>
	attempts.map(({ provider, result }) => `${provider.id} ${result.ok ? 'ok' : `${result.error} ${result.detail}`}`);

test('a busy or unreachable chosen provider hands the request to the other one once, and every other failure stays with it', async () => {
	const table: [Reply, string, boolean][] = [
		[429, 'rate-limit HTTP 429', true],
		[500, 'failed HTTP 500', true],
		[502, 'failed HTTP 502', true],
		[503, 'failed HTTP 503', true],
		[529, 'failed HTTP 529', true],
		['hang', 'network timed out before the response headers', true],
		['refuse', 'network TypeError: Failed to fetch', true],
		['break', 'network the connection broke in the body: TypeError: network error', true],
		[400, 'failed HTTP 400', false],
		[401, 'refused HTTP 401', false],
		[403, 'refused HTTP 403', false],
		[404, 'failed HTTP 404', false],
		['empty', 'failed empty content', false],
		['schema', 'failed content does not match the schema: units [] for 2 blocks', false],
	];
	for (const [reply, failure, fallsBack] of table) {
		const hosts = serve({ 'first.test': reply, 'second.test': 'answer' });
		const tried = outcome(await foldWith(both, recorded.request, fast));
		expect({ reply, tried, hosts }).toEqual({
			reply,
			tried: fallsBack ? [`opengateway ${failure}`, 'openrouter ok'] : [`opengateway ${failure}`],
			hosts: fallsBack ? ['first.test', 'second.test'] : ['first.test'],
		});
	}
});

test('a chosen provider that times out leaves the other one the rest of the time', async () => {
	serve({ 'first.test': 'hang', 'second.test': 'answer' });
	const started = performance.now();
	const attempts = await foldWith(both, recorded.request, fast);
	expect(outcome(attempts)).toEqual(['opengateway network timed out before the response headers', 'openrouter ok']);
	expect(attempts[0].ms).toBeGreaterThanOrEqual(fast.firstTryMs - 5);
	expect(attempts[0].ms).toBeLessThan(fast.totalMs);
	expect(performance.now() - started).toBeLessThan(fast.totalMs);
});

test('with one key there is no fallback, and the only attempt gets the whole time', async () => {
	const hosts = serve({ 'first.test': 'hang', 'second.test': 'answer' });
	const attempts = await foldWith({ first: both.first, fallback: undefined }, recorded.request, fast);
	expect(outcome(attempts)).toEqual(['opengateway network timed out before the response headers']);
	expect(attempts[0].ms).toBeGreaterThanOrEqual(fast.totalMs - 5);
	expect(hosts).toEqual(['first.test']);
	serve({ 'first.test': 429 });
	expect(outcome(await foldWith({ first: both.first, fallback: undefined }, recorded.request, fast))).toEqual(['opengateway rate-limit HTTP 429']);
});

test('the fallback gets only the time left, and a busy fallback is the last word', async () => {
	serve({ 'first.test': 'hang', 'second.test': 'hang' });
	const started = performance.now();
	expect(outcome(await foldWith(both, recorded.request, fast))).toEqual([
		'opengateway network timed out before the response headers',
		'openrouter network timed out before the response headers',
	]);
	expect(performance.now() - started).toBeGreaterThanOrEqual(fast.totalMs - 5);
	expect(performance.now() - started).toBeLessThan(fast.totalMs + 100);
	const hosts = serve({ 'first.test': 503, 'second.test': 429 });
	expect(outcome(await foldWith(both, recorded.request, fast))).toEqual(['opengateway failed HTTP 503', 'openrouter rate-limit HTTP 429']);
	expect(hosts).toEqual(['first.test', 'second.test']);
});
