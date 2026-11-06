import { test as base } from '@playwright/test';
import { launch, type Harness } from './harness.ts';

export const test = base.extend<{ allowLiveHosts: readonly string[]; lang: string | undefined; h: Harness }>({
	allowLiveHosts: [[], { option: true }],
	lang: [undefined, { option: true }],
	h: async ({ headless, allowLiveHosts, lang }, use) => {
		const h = await launch({ headless, allowLiveHosts, lang });
		await use(h);
		await h.close();
	},
});

export const inKorean = test.extend({ lang: 'ko' });

export { expect } from '@playwright/test';
