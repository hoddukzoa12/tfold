import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { FoldRequest } from '../prompt.ts';
import { parseProvider } from './index.ts';
import { presets, providerIds } from './presets.ts';
import { bodies, requestBody } from './request-body.ts';

const { request } = JSON.parse(await readFile(path.join(import.meta.dirname, 'openrouter-response.json'), 'utf8')) as { request: FoldRequest };
const openRouterBody = requestBody(parseProvider('openrouter', { apiKey: 'test-key' }), request);
const openGatewayBody = requestBody(parseProvider('opengateway', { apiKey: 'test-key' }), request);

test('the OpenRouter request body keeps every byte it had', async () => {
	await expect(JSON.stringify(openRouterBody, null, '\t')).toMatchFileSnapshot('__snapshots__/openrouter-body.json');
});

test('both bodies ask for strict JSON schema output with exactly one unit per block', () => {
	expect(request.blocks).toHaveLength(2);
	for (const body of [openRouterBody, openGatewayBody]) {
		expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
		expect(body.response_format.json_schema.schema.properties.units).toMatchObject({
			minItems: 2,
			maxItems: 2,
			items: { properties: { id: { enum: ['U0', 'U1'] } } },
		});
	}
});

test('the OpenGateway body has no provider field and turns reasoning off with reasoning_effort, and is otherwise the OpenRouter body', () => {
	expect(openGatewayBody.model).toBe('deepseek/deepseek-v4.1-flash-ultrafast');
	expect(openGatewayBody).not.toHaveProperty('provider');
	expect(openGatewayBody).not.toHaveProperty('reasoning');
	expect(openGatewayBody).toHaveProperty('reasoning_effort', 'none');
	const { reasoning, provider, max_tokens, ...shared } = bodies.openrouter(openGatewayBody.model, request);
	expect(reasoning).toEqual({ enabled: false });
	expect(provider).toEqual({ require_parameters: true });
	expect(JSON.stringify(openGatewayBody)).toBe(JSON.stringify({ ...shared, max_tokens: openGatewayBody.max_tokens, reasoning_effort: 'none' }));
	expect(max_tokens).toBe(openRouterBody.max_tokens);
});

test.each([1, 3, 8])('with %i paragraphs, the OpenGateway ceiling holds the longest reasoning seen live and the whole answer after it', (paragraphs) => {
	const longestReasoningSeen = 3850;
	const [block] = request.blocks;
	if (!block) throw new Error('the recording has no block');
	const window = { ...request, blocks: Array.from({ length: paragraphs }, () => block) };
	const answer = bodies.openrouter(presets.openrouter.model, window).max_tokens;
	expect(bodies.opengateway(presets.opengateway.model, window).max_tokens).toBeGreaterThanOrEqual(longestReasoningSeen + answer);
});

test('each preset names a page to get a key on and a key check under its own base URL', () => {
	expect(presets.openrouter.keysPage).toBe('https://openrouter.ai/settings/keys');
	expect(presets.opengateway.keysPage).toBe('https://opengateway.ai/api-keys');
	for (const id of providerIds) expect(presets[id].keyCheck.path, id).toMatch(/^\//);
});

test('the manifest grants the host of each preset, http and https pages so tfold can start in tabs open at install, and no other', async () => {
	const manifest = JSON.parse(await readFile(path.join(import.meta.dirname, '..', '..', 'manifest.json'), 'utf8')) as { host_permissions: string[] };
	const presetHosts = providerIds.map((id) => `${new URL(presets[id].baseUrl).origin}/*`);
	expect(manifest.host_permissions.toSorted()).toEqual([...presetHosts, 'http://*/*', 'https://*/*'].toSorted());
});
