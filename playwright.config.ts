import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.spec.ts',
	outputDir: 'e2e/out/test-results',
	workers: 1,
	timeout: 60_000,
	reporter: 'list',
});
