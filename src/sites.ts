export function hostOf(url: string | undefined): string | undefined {
	if (url === undefined || !URL.canParse(url)) return undefined;
	const { protocol, hostname } = new URL(url);
	return protocol === 'http:' || protocol === 'https:' ? hostname : undefined;
}

export const parseSites = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((host): host is string => typeof host === 'string') : []);
