import { readAnswer, type FoldRequest } from '../prompt.ts';
import type { FoldError, FoldResult } from './index.ts';
import { presets, type KeyCheck, type ProviderId } from './presets.ts';
import { requestBody } from './request-body.ts';

export type OpenAiCompatible = { kind: 'openai-compatible'; id: ProviderId; baseUrl: string; apiKey: string; model: string };
export type KeyVerdict = 'works' | 'refused' | 'unknown' | 'malformed';

const statusErrors: Record<number, FoldError> = { 401: 'refused', 403: 'refused', 429: 'rate-limit' };

const busyStatus = (status: number) => status === 429 || status >= 500;

const failed = (error: FoldError, detail: string, busy = false): FoldResult => ({ ok: false, error, detail, busy });

function unitIds(answer: unknown): string {
	const units = typeof answer === 'object' && answer !== null ? (answer as { units?: unknown }).units : undefined;
	if (!Array.isArray(units)) return 'no units array';
	return `units ${JSON.stringify(units.map((unit: unknown) => (typeof unit === 'object' && unit !== null ? (unit as { id?: unknown }).id : unit)))}`;
}

export function readCompletion(request: FoldRequest, body: unknown): FoldResult {
	const completion = (typeof body === 'object' && body !== null ? body : {}) as {
		provider?: unknown;
		choices?: { finish_reason?: unknown; message?: { content?: unknown } }[];
		usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown }; cost?: unknown };
	};
	const choice = Array.isArray(completion.choices) ? completion.choices[0] : undefined;
	if (!choice) return failed('failed', 'no choices');
	const usage = completion.usage ?? {};
	const completionTokens = Number(usage.completion_tokens ?? 0);
	const reasoningTokens = Number(usage.completion_tokens_details?.reasoning_tokens ?? 0);
	if (choice.finish_reason !== 'stop') return failed('failed', `finish_reason ${String(choice.finish_reason)}, ${completionTokens} output tokens, ${reasoningTokens} of them reasoning`);
	const content = choice.message?.content;
	if (typeof content !== 'string' || content.trim() === '') return failed('failed', 'empty content');
	let answer: unknown;
	try {
		answer = JSON.parse(content);
	} catch {
		return failed('failed', 'content is not JSON');
	}
	const folds = readAnswer(request, answer);
	if (!folds) return failed('failed', `content does not match the schema: ${unitIds(answer)} for ${request.blocks.length} blocks`);
	return {
		ok: true,
		folds,
		usage: {
			promptTokens: Number(usage.prompt_tokens ?? 0),
			completionTokens,
			reasoningTokens,
			cost: typeof usage.cost === 'number' ? usage.cost : undefined,
			upstream: typeof completion.provider === 'string' ? completion.provider : undefined,
		},
	};
}

export async function foldOpenAiCompatible(provider: OpenAiCompatible, request: FoldRequest, signal: AbortSignal): Promise<FoldResult> {
	let response: Response;
	try {
		response = await fetch(`${provider.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify(requestBody(provider, request)),
			signal,
		});
	} catch (error) {
		return signal.aborted ? failed('network', 'timed out before the response headers', true) : failed('network', String(error), error instanceof TypeError);
	}
	if (!response.ok) return failed(statusErrors[response.status] ?? 'failed', `HTTP ${response.status}`, busyStatus(response.status));
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		if (signal.aborted) return failed('network', 'timed out reading the response body', true);
		return error instanceof TypeError ? failed('network', `the connection broke in the body: ${String(error)}`, true) : failed('failed', `the body is not JSON: ${String(error)}`);
	}
	return readCompletion(request, body);
}

const headerValue = /^[\x21-\x7e]+$/;

// Far above any real key and far below the 8 KB header where the server in front of OpenGateway answers HTML of its own.
export const maxKeyLength = 2048;

export const wellFormedKey = (apiKey: string): boolean => apiKey.length <= maxKeyLength && headerValue.test(apiKey);

// The status alone proves nothing: a server in front or a captive portal can answer the accepted status without
// reading the key. The detail goes to the worker's log, so it names a status or a cause and never the error text,
// which could quote the key.
export async function checkKey({ id, baseUrl, apiKey }: OpenAiCompatible, signal: AbortSignal): Promise<{ verdict: KeyVerdict; detail: string }> {
	if (!wellFormedKey(apiKey)) return { verdict: 'malformed', detail: 'not a key' };
	const { method, path, body, accepted, proves }: KeyCheck = presets[id].keyCheck;
	let response: Response;
	try {
		response = await fetch(`${baseUrl}${path}`, {
			method,
			headers: { authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
			body,
			signal,
		});
	} catch {
		return { verdict: 'unknown', detail: signal.aborted ? 'timed out' : 'no connection' };
	}
	const detail = `HTTP ${response.status}`;
	if (response.status !== accepted) {
		void response.body?.cancel();
		return { verdict: statusErrors[response.status] === 'refused' ? 'refused' : 'unknown', detail };
	}
	const reply: unknown = await response.json().catch(() => undefined);
	return proves(reply) ? { verdict: 'works', detail } : { verdict: 'unknown', detail: `${detail}, not the expected reply` };
}
