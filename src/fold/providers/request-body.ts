import { promptFor, schemaFor, system, type FoldRequest } from '../prompt.ts';
import type { ProviderId } from './presets.ts';

const tokensPerBlock = 250;
// OpenGateway's model still reasons on about one call in five, out of the same max_tokens, so a ceiling that holds only
// the answer ends those calls with no answer. Reasoning ran past 3,850 tokens live. At the 430 tokens a second of its
// fastest calls the 12 s deadline ends a call near 5,200, so with this room the deadline ends it, not the ceiling.
const reasoningRoom = 5000;

function common(request: FoldRequest) {
	return {
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: promptFor(request) },
		],
		response_format: { type: 'json_schema', json_schema: { name: 'fold', strict: true, schema: schemaFor(request) } },
		max_tokens: 100 + tokensPerBlock * request.blocks.length,
	};
}

export const bodies = {
	// OpenGateway answers HTTP 400 to `provider.require_parameters` and ignores `reasoning.enabled`. `reasoning_effort:
	// "none"` is the setting that lowers its reasoning, from every call to about one in five, and none stops it outright.
	opengateway: (model: string, request: FoldRequest) => {
		const { messages, response_format, max_tokens } = common(request);
		return { model, messages, response_format, max_tokens: max_tokens + reasoningRoom, reasoning_effort: 'none' };
	},
	openrouter: (model: string, request: FoldRequest) => {
		const { messages, response_format, max_tokens } = common(request);
		return { model, messages, response_format, reasoning: { enabled: false }, provider: { require_parameters: true }, max_tokens };
	},
} satisfies Record<ProviderId, (model: string, request: FoldRequest) => object>;

export function requestBody(provider: { id: ProviderId; model: string }, request: FoldRequest): ReturnType<(typeof bodies)[ProviderId]> {
	return bodies[provider.id](provider.model, request);
}
