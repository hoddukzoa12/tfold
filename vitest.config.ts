import { defineConfig } from 'vitest/config';

export default defineConfig({
	define: { TFOLD_EDITION: '"store"', TFOLD_DEV: 'false' },
	test: {
		include: ['src/**/*.test.ts', 'e2e/**/*.test.ts'],
		testTimeout: 30_000,
	},
});
