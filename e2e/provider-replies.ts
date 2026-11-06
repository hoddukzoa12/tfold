export const openRouterKeyReply = JSON.stringify({ data: { label: 'sk-or-v1-abc...123', limit: 5, usage: 0.25 } });

const missingField = (param: string) => JSON.stringify({ error: { message: 'must not be empty', type: 'invalid_request_error', param } });

let turn = 0;

// What OpenGateway answers a real key, measured live. A body with neither field named `model` in 34 of 60 replies and
// `messages` in 26 of 60, in no fixed order. A body naming a model, real or not, named `messages` in 52 of 52.
export function openGatewayKeyReply(sent: unknown): string {
	const body = JSON.parse(typeof sent === 'string' ? sent : '{}') as { model?: unknown };
	if (body.model !== undefined) return missingField('messages');
	return missingField(turn++ % 2 === 0 ? 'model' : 'messages');
}
