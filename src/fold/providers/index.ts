import { requestTimeoutMs } from '../../messages.ts';
import type { FoldRequest } from '../prompt.ts';
import type { Fold } from '../types.ts';
import { foldOpenAiCompatible, type OpenAiCompatible } from './openai-compatible.ts';
import { presets, providerIds, type ProviderId } from './presets.ts';

export type Provider = OpenAiCompatible;

export type FoldError = 'no-key' | 'quick-only' | 'refused' | 'rate-limit' | 'network' | 'failed';
export type Usage = { promptTokens: number; completionTokens: number; reasoningTokens: number; cost: number | undefined; upstream: string | undefined };
export type FoldResult = { ok: true; folds: Fold[]; usage: Usage } | { ok: false; error: FoldError; detail: string; busy: boolean };

export type ProviderSettings = { chosen: ProviderId | undefined; providers: Record<ProviderId, Provider> };
export type Route = { first: Provider; fallback: Provider | undefined };
export type Attempt = { provider: Provider; result: FoldResult; ms: number };

// With a second provider to ask, the first gets half of the request time so that the second still has six seconds.
// Over 443 calls each, 5 OpenRouter calls and 1 OpenGateway call took longer than 6 s, and OpenRouter answered a
// window of five to eight paragraphs in 5.1 s at p95.
export const firstTryMs = requestTimeoutMs / 2;

const asRecord = (raw: unknown) => (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {});

export function parseProvider(id: ProviderId, raw: unknown): Provider {
	const stored = asRecord(raw);
	const text = (name: 'baseUrl' | 'apiKey' | 'model', fallback: string) => {
		const value = stored[name];
		return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
	};
	return {
		kind: 'openai-compatible',
		id,
		baseUrl: text('baseUrl', presets[id].baseUrl).replace(/\/+$/, ''),
		apiKey: text('apiKey', ''),
		model: text('model', presets[id].model),
	};
}

const modelId = /^[\w.-]+(?:\/[\w.:+~-]+)+$/;

export const wellFormedModel = (model: string): boolean => model.length <= 200 && modelId.test(model);

const isProviderId = (value: unknown): value is ProviderId => providerIds.some((id) => id === value);

export function parseSettings({ providers, provider }: { providers?: unknown; provider?: unknown }): ProviderSettings {
	if (providers === undefined && provider !== undefined) {
		const openrouter = parseProvider('openrouter', provider);
		return { chosen: openrouter.apiKey ? 'openrouter' : undefined, providers: { opengateway: parseProvider('opengateway', undefined), openrouter } };
	}
	const stored = asRecord(providers);
	return {
		chosen: isProviderId(stored.chosen) ? stored.chosen : undefined,
		providers: { opengateway: parseProvider('opengateway', stored.opengateway), openrouter: parseProvider('openrouter', stored.openrouter) },
	};
}

export function storedSettings({ chosen, providers }: ProviderSettings): Record<string, unknown> {
	const entry = ({ id, baseUrl, apiKey, model }: Provider) => ({
		apiKey,
		...(model === presets[id].model ? {} : { model }),
		...(baseUrl === presets[id].baseUrl ? {} : { baseUrl }),
	});
	return { ...(chosen ? { chosen } : {}), opengateway: entry(providers.opengateway), openrouter: entry(providers.openrouter) };
}

export function chosenId({ chosen, providers }: ProviderSettings): ProviderId {
	return chosen ?? (providers.openrouter.apiKey && !providers.opengateway.apiKey ? 'openrouter' : 'opengateway');
}

export function routeOf(settings: ProviderSettings): Route | undefined {
	const first = settings.providers[chosenId(settings)];
	if (!first.apiKey) return undefined;
	const fallback = providerIds.map((id) => settings.providers[id]).find((provider) => provider.id !== first.id && provider.apiKey);
	return { first, fallback };
}

function foldOnce(provider: Provider, request: FoldRequest, signal: AbortSignal): Promise<FoldResult> {
	switch (provider.kind) {
		case 'openai-compatible':
			return foldOpenAiCompatible(provider, request, signal);
	}
}

async function attempt(provider: Provider, request: FoldRequest, signal: AbortSignal): Promise<Attempt> {
	const started = performance.now();
	const result = await foldOnce(provider, request, signal);
	return { provider, result, ms: Math.round(performance.now() - started) };
}

export async function foldWith(
	{ first, fallback }: Route,
	request: FoldRequest,
	timing = { totalMs: requestTimeoutMs, firstTryMs },
): Promise<[Attempt] | [Attempt, Attempt]> {
	const deadline = AbortSignal.timeout(timing.totalMs);
	const tried = await attempt(first, request, fallback ? AbortSignal.any([deadline, AbortSignal.timeout(timing.firstTryMs)]) : deadline);
	if (!fallback || tried.result.ok || !tried.result.busy || deadline.aborted) return [tried];
	return [tried, await attempt(fallback, request, deadline)];
}
