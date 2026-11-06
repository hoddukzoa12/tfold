export const providerIds = ['opengateway', 'openrouter'] as const;
export type ProviderId = (typeof providerIds)[number];

export type KeyCheck = { method: 'GET' | 'POST'; path: string; body?: string; accepted: number; proves: (reply: unknown) => boolean };
type Preset = { name: string; baseUrl: string; model: string; keysPage: string; keyCheck: KeyCheck };

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

const openGatewayModel = 'deepseek/deepseek-v4.1-flash-ultrafast';

export const presets = {
	opengateway: {
		name: 'OpenGateway',
		baseUrl: 'https://apis.opengateway.ai/v1',
		model: openGatewayModel,
		keysPage: 'https://opengateway.ai/api-keys',
		// OpenGateway has no key endpoint and its /models is public. It reads the key before the body, so a body with no
		// messages answers 401 to a bad key and, to a good one, a 400 that names the messages, and no model runs. The body
		// names a model because a body with neither field names either one, in no fixed order.
		keyCheck: { method: 'POST', path: '/chat/completions', body: JSON.stringify({ model: openGatewayModel }), accepted: 400, proves: (reply) => asRecord(asRecord(reply).error).param === 'messages' },
	},
	openrouter: {
		name: 'OpenRouter',
		baseUrl: 'https://openrouter.ai/api/v1',
		model: 'deepseek/deepseek-v4.1-flash-1017',
		keysPage: 'https://openrouter.ai/settings/keys',
		keyCheck: { method: 'GET', path: '/key', accepted: 200, proves: (reply) => typeof asRecord(asRecord(reply).data).label === 'string' },
	},
} satisfies Record<ProviderId, Preset>;
