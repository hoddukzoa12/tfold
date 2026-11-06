import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { openGatewayKeyReply, openRouterKeyReply } from '../../../e2e/provider-replies.ts';
import type { FoldRequest } from '../prompt.ts';
import { parseProvider, type FoldResult } from './index.ts';
import { checkKey, foldOpenAiCompatible, maxKeyLength, readCompletion, wellFormedKey } from './openai-compatible.ts';
import { presets } from './presets.ts';

type Recorded = { request: FoldRequest; response: { choices: { finish_reason: string; message: { content: string } }[] } };

const recorded = JSON.parse(await readFile(path.join(import.meta.dirname, 'openrouter-response.json'), 'utf8')) as Recorded;
const provider = parseProvider('openrouter', { apiKey: 'test-key' });
const open = () => new AbortController().signal;

function withChoice(change: { finish_reason?: string; content?: string }) {
	const [choice] = recorded.response.choices;
	if (!choice) throw new Error('the recording has no choice');
	return {
		...recorded.response,
		choices: [{ ...choice, ...change, message: { ...choice.message, ...('content' in change ? { content: change.content } : {}) } }],
	};
}

afterEach(() => vi.unstubAllGlobals());

test('a recorded OpenRouter response becomes one fold per block, with usage', () => {
	const result = readCompletion(recorded.request, recorded.response);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.folds).toHaveLength(recorded.request.blocks.length);
	for (const [i, fold] of result.folds.entries()) {
		const sentences = recorded.request.blocks[i]?.sentences ?? [];
		expect(fold.sentences).toEqual(sentences);
		expect(fold.brief.length).toBeGreaterThan(0);
		expect(fold.brief.every((index) => index >= 0 && index < sentences.length)).toBe(true);
		expect(fold.key.startsWith(fold.takeaway)).toBe(true);
	}
	expect(result.usage.promptTokens).toBeGreaterThan(0);
	expect(result.usage.completionTokens).toBeGreaterThan(0);
	expect(result.usage.reasoningTokens).toBe(0);
	expect(result.usage.cost).toBeGreaterThan(0);
	expect(result.usage.upstream).toBe('InferenceNet');
});

test('a malformed response is a failed fold', () => {
	const bad = (body: unknown): FoldResult => readCompletion(recorded.request, body);
	expect(bad(withChoice({ content: '{"units": [' }))).toMatchObject({ ok: false, error: 'failed', detail: 'content is not JSON' });
	const blocks = recorded.request.blocks.length;
	expect(bad(withChoice({ content: '{"units": []}' }))).toMatchObject({
		ok: false,
		error: 'failed',
		detail: `content does not match the schema: units [] for ${blocks} blocks`,
	});
	expect(bad(withChoice({ content: '{"units": [{"id": "U0"}, {"id": "U0"}]}' }))).toMatchObject({
		detail: `content does not match the schema: units ["U0","U0"] for ${blocks} blocks`,
	});
	expect(bad(withChoice({ content: '{"answer": 1}' }))).toMatchObject({ detail: `content does not match the schema: no units array for ${blocks} blocks` });
	expect(bad({ error: { message: 'Internal error' } })).toMatchObject({ ok: false, error: 'failed', detail: 'no choices' });
});

test('an empty content is a failed fold', () => {
	expect(readCompletion(recorded.request, withChoice({ content: '' }))).toMatchObject({ ok: false, error: 'failed', detail: 'empty content' });
	expect(readCompletion(recorded.request, withChoice({ content: '  \n' }))).toMatchObject({ ok: false, error: 'failed' });
});

const cutOff = { usage: { prompt_tokens: 1805, completion_tokens: 850, completion_tokens_details: { reasoning_tokens: 595 } } };

test.each([
	['no answer after the reasoning', ''],
	['an answer that stops mid-string', '{"units": [{"id": "U0", "takeaway": "A line that sto'],
	['a whole answer', undefined],
])('a reply that ran out of max_tokens with %s gives no fold, and its log line says what took the tokens', (_what, content) => {
	const reply = { ...withChoice({ finish_reason: 'length', ...(content === undefined ? {} : { content }) }), ...cutOff };
	expect(readCompletion(recorded.request, reply)).toEqual({
		ok: false,
		error: 'failed',
		detail: 'finish_reason length, 850 output tokens, 595 of them reasoning',
		busy: false,
	});
});

test('HTTP statuses and a failed fetch map to the badge errors', async () => {
	const statuses: [number, string, boolean][] = [
		[400, 'failed', false],
		[401, 'refused', false],
		[403, 'refused', false],
		[429, 'rate-limit', true],
		[500, 'failed', true],
		[503, 'failed', true],
		[529, 'failed', true],
	];
	for (const [status, error, busy] of statuses) {
		vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status })));
		expect(await foldOpenAiCompatible(provider, recorded.request, open())).toEqual({ ok: false, error, detail: `HTTP ${status}`, busy });
	}
	vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
	expect(await foldOpenAiCompatible(provider, recorded.request, open())).toEqual({ ok: false, error: 'network', detail: 'TypeError: Failed to fetch', busy: true });
	const broken = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new TypeError('network error')) });
	vi.stubGlobal('fetch', () => Promise.resolve(new Response(broken, { status: 200 })));
	expect(await foldOpenAiCompatible(provider, recorded.request, open())).toMatchObject({ ok: false, error: 'network', busy: true });
	vi.stubGlobal('fetch', () => Promise.resolve(new Response('<html>', { status: 200 })));
	expect(await foldOpenAiCompatible(provider, recorded.request, open())).toMatchObject({ ok: false, error: 'failed', busy: false });
	const sent: RequestInit[] = [];
	vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
		expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
		sent.push(init);
		return Promise.resolve(Response.json(recorded.response));
	});
	expect(await foldOpenAiCompatible(provider, recorded.request, open())).toMatchObject({ ok: true });
	expect(new Headers(sent[0]?.headers).get('authorization')).toBe('Bearer test-key');
});

test('no answer before the deadline is a network failure, whether the headers or the body never arrive', async () => {
	const onAbort = (init: RequestInit, act: (reason: unknown) => void) => init.signal?.addEventListener('abort', () => act(init.signal?.reason));
	vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => onAbort(init, reject)));
	expect(await foldOpenAiCompatible(provider, recorded.request, AbortSignal.timeout(20))).toEqual({
		ok: false,
		error: 'network',
		detail: 'timed out before the response headers',
		busy: true,
	});
	vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"choices": ['));
				onAbort(init, (reason) => controller.error(reason));
			},
		});
		return Promise.resolve(new Response(body, { status: 200 }));
	});
	expect(await foldOpenAiCompatible(provider, recorded.request, AbortSignal.timeout(20))).toEqual({
		ok: false,
		error: 'network',
		detail: 'timed out reading the response body',
		busy: true,
	});
});

const secret = 'sk-or-v1-secret-value';
const withKey = (id: 'opengateway' | 'openrouter', apiKey = secret) => parseProvider(id, { apiKey });

const realReply = {
	openrouter: { status: 200, body: openRouterKeyReply },
	opengateway: { status: 400, body: openGatewayKeyReply(JSON.stringify({ model: presets.opengateway.model })) },
};
const tomcat400 = '<!doctype html><html lang="en"><head><title>HTTP Status 400 – Bad Request</title></head><body><h1>HTTP Status 400 – Bad Request</h1></body></html>';

const verdictFor = async (id: 'opengateway' | 'openrouter', reply: { status: number; body: string | null }) => {
	vi.stubGlobal('fetch', () => Promise.resolve(new Response(reply.body, { status: reply.status })));
	return checkKey(withKey(id), open());
};

test('a real OpenGateway key reads as works every time, even though the reply to an empty body names a different field from one try to the next', async () => {
	vi.stubGlobal('fetch', (_url: string, init: RequestInit) => Promise.resolve(new Response(openGatewayKeyReply(init.body), { status: 400 })));
	const verdicts = [];
	for (let i = 0; i < 12; i++) verdicts.push((await checkKey(withKey('opengateway'), open())).verdict);
	expect(verdicts).toEqual(Array.from({ length: 12 }, () => 'works'));
});

test('the reply a body with no model gets is what the live service gives: not always the field the check needs', () => {
	const params = Array.from({ length: 4 }, () => (JSON.parse(openGatewayKeyReply('{}')) as { error: { param: string } }).error.param);
	expect(new Set(params)).toEqual(new Set(['model', 'messages']));
});

test.each([
	['openrouter', 'GET', 'https://openrouter.ai/api/v1/key', undefined],
	['opengateway', 'POST', 'https://apis.opengateway.ai/v1/chat/completions', JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-ultrafast' })],
] as const)('%s checks a key with %s and spends nothing, sending no text for a model to answer', async (id, method, url, body) => {
	const sent: { url: string; init: RequestInit }[] = [];
	vi.stubGlobal('fetch', (to: string, init: RequestInit) => {
		sent.push({ url: to, init });
		return Promise.resolve(new Response(realReply[id].body, { status: realReply[id].status }));
	});
	expect(await checkKey(withKey(id), open())).toEqual({ verdict: 'works', detail: `HTTP ${realReply[id].status}` });
	expect(sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({ url, init: { method, body } });
	expect(new Headers(sent[0]?.init.headers).get('authorization')).toBe(`Bearer ${secret}`);
});

test('401 and 403 refuse a key whatever the body says, and every other status leaves it unchecked', async () => {
	for (const id of ['opengateway', 'openrouter'] as const) {
		for (const status of [401, 403]) {
			for (const body of [null, '{}', '<html>no</html>']) expect((await verdictFor(id, { status, body })).verdict, `${id} ${status} ${body}`).toBe('refused');
		}
		for (const status of [402, 404, 429, 500, 502, 503, 529]) expect((await verdictFor(id, { status, body: realReply[id].body })).verdict, `${id} ${status}`).toBe('unknown');
	}
	expect((await verdictFor('openrouter', realReply.opengateway)).verdict).toBe('unknown');
	expect((await verdictFor('opengateway', realReply.openrouter)).verdict).toBe('unknown');
});

test.each([
	['opengateway', 400, 'the HTML that the server in front answers a 9 KB header with', tomcat400],
	['opengateway', 400, 'an empty body', ''],
	['opengateway', 400, 'JSON with no error', '{}'],
	['opengateway', 400, 'an error that is only a word', '{"error":"Bad Request"}'],
	['opengateway', 400, 'an error about something other than the empty messages', '{"error":{"type":"invalid_request_error","message":"header too large"}}'],
	['openrouter', 200, 'a captive portal page', '<html><title>Sign in to the wifi</title></html>'],
	['openrouter', 200, 'an empty body', ''],
	['openrouter', 200, 'JSON with no data', '{}'],
	['openrouter', 200, 'an error in a 200', '{"error":"nope"}'],
	['openrouter', 200, 'empty data', '{"data":null}'],
	['openrouter', 200, 'data that is only a word', '{"data":"sk-or"}'],
	['openrouter', 200, 'empty data', '{"data":{}}'],
	['openrouter', 200, 'data with no label', '{"data":{"usage":0}}'],
	['openrouter', 200, 'data that is a list', '{"data":[{"label":"sk-or"}]}'],
	['openrouter', 200, 'a label that is not text', '{"data":{"label":1}}'],
] as const)('%s answering %i with %s leaves the key unchecked, because only the expected reply proves it works', async (id, status, _what, body) => {
	expect(await verdictFor(id, { status, body })).toEqual({ verdict: 'unknown', detail: `HTTP ${status}, not the expected reply` });
});

test('a body that breaks off while it is read leaves the key unchecked', async () => {
	vi.stubGlobal('fetch', () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"data":'));
				controller.error(new TypeError(`network error for ${secret}`));
			},
		});
		return Promise.resolve(new Response(body, { status: 200 }));
	});
	const broken = await checkKey(withKey('openrouter'), open());
	expect(broken).toEqual({ verdict: 'unknown', detail: 'HTTP 200, not the expected reply' });
	expect(JSON.stringify(broken)).not.toContain(secret);
});

test('a failed or timed out request leaves a key unchecked, and no detail quotes the key', async () => {
	vi.stubGlobal('fetch', () => Promise.reject(new TypeError(`Failed to fetch with Bearer ${secret}`)));
	const failed = await checkKey(withKey('openrouter'), open());
	expect(failed).toEqual({ verdict: 'unknown', detail: 'no connection' });
	vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error(secret)))));
	const timedOut = await checkKey(withKey('openrouter'), AbortSignal.timeout(20));
	expect(timedOut).toEqual({ verdict: 'unknown', detail: 'timed out' });
	expect(JSON.stringify([failed, timedOut])).not.toContain(secret);
});

test('a key that cannot be a key is malformed without a request, and the longest plausible key still goes out', async () => {
	const fetched = vi.fn(() => Promise.resolve(new Response(realReply.openrouter.body, { status: 200 })));
	vi.stubGlobal('fetch', fetched);
	for (const apiKey of ['한글키', 'two words', 'tab\tkey', 'a'.repeat(maxKeyLength + 1), 'a'.repeat(9 * 1024)]) {
		expect(wellFormedKey(apiKey), apiKey.slice(0, 20)).toBe(false);
		expect(await checkKey(withKey('openrouter', apiKey), open()), apiKey.slice(0, 20)).toEqual({ verdict: 'malformed', detail: 'not a key' });
	}
	expect(fetched).not.toHaveBeenCalled();
	const longest = 'a'.repeat(maxKeyLength);
	expect(wellFormedKey(longest)).toBe(true);
	expect((await checkKey(withKey('openrouter', longest), open())).verdict).toBe('works');
	expect(fetched).toHaveBeenCalledOnce();
});
