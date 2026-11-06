import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { en, enStore, type Strings } from './strings/en.ts';
import { ko, koStore } from './strings/ko.ts';

const src = import.meta.dirname;
const read = (file: string) => readFileSync(path.join(src, file), 'utf8');
const tables = { en: { ...en, ...enStore }, ko: { ...ko, ...koStore } };

type Change = Record<string, { newValue?: unknown }>;

function fakeChrome(uiLanguage: string, synced: Record<string, unknown> = {}) {
	const listeners: ((changes: Change, area: string) => void)[] = [];
	const chrome = {
		i18n: { getUILanguage: () => uiLanguage },
		storage: {
			sync: {
				get: (key: string) => Promise.resolve(key in synced ? { [key]: synced[key] } : {}),
				set: (items: Record<string, unknown>) => {
					Object.assign(synced, items);
					for (const listener of listeners) listener(Object.fromEntries(Object.entries(items).map(([key, newValue]) => [key, { newValue }])), 'sync');
					return Promise.resolve();
				},
			},
			onChanged: { addListener: (listener: (changes: Change, area: string) => void) => listeners.push(listener) },
		},
	};
	vi.stubGlobal('chrome', chrome);
	return chrome;
}

async function freshI18n() {
	vi.resetModules();
	return import('./i18n.ts');
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('translations', () => {
	test('the manifest and the store read only the name and the description from _locales, in English by default and in Korean', () => {
		expect(readdirSync(path.join(src, '_locales')).sort()).toEqual(['en', 'ko']);
		expect(JSON.parse(read('manifest.json'))).toMatchObject({ default_locale: 'en', name: '__MSG_appName__', description: '__MSG_appDescription__' });
		for (const locale of ['en', 'ko']) {
			const messages = JSON.parse(read(`_locales/${locale}/messages.json`)) as Record<string, { message: string }>;
			expect(Object.keys(messages).sort(), locale).toEqual(['appDescription', 'appName']);
			for (const { message } of Object.values(messages)) expect(message.trim(), locale).not.toBe('');
		}
	});

	test.each(Object.entries(tables))('every %s message is filled in and has no em dash', (_, table) => {
		const sample = { nodeName: 'KBD' } as unknown as Node;
		for (const [key, message] of Object.entries(table) as [keyof Strings, unknown][]) {
			const shown = typeof message === 'function' ? (message as (...args: unknown[]) => unknown)(sample, sample) : message;
			const text = (Array.isArray(shown) ? shown : [shown]).map((part: unknown) => (part === sample ? '' : typeof part === 'string' ? part : JSON.stringify(part))).join('');
			expect(text.trim(), key).not.toBe('');
			expect(text, key).not.toContain('—');
		}
	});

	test('every key the pages name is a plain string in both languages', () => {
		const named = ['options/options.html', 'popup/popup.html'].flatMap((page) => [...read(page).matchAll(/data-i18n="(\w+)"/g)].map(([, key]) => key as keyof Strings));
		expect(named.length).toBeGreaterThan(10);
		for (const key of named) expect([typeof tables.en[key], typeof tables.ko[key]], key).toEqual(['string', 'string']);
	});

	test('a table that leaves out a key, or a call that leaves out an argument, does not type-check', async () => {
		const { popupSite, ...withoutPopupSite } = tables.en;
		// @ts-expect-error popupSite is missing
		const missing: Strings = withoutPopupSite;
		const { t } = await import('./i18n.ts');
		const withoutProvider = (saved: boolean) =>
			// @ts-expect-error keyLabel needs the provider name even when it is one of two keys
			t(saved ? 'keySaved' : 'keyLabel');
		expect([popupSite, Object.keys(missing).length, withoutProvider.length]).toEqual(['Use on this site', Object.keys(tables.en).length - 1, 1]);
	});
});

describe('reader language', () => {
	test('a stored value other than en or ko reads as auto, and auto follows the browser', async () => {
		fakeChrome('ko-KR');
		const { parseReaderLanguage, languageOf } = await freshI18n();
		expect([undefined, 'fr', 'KO', 1, 'auto', 'en', 'ko'].map(parseReaderLanguage)).toEqual(['auto', 'auto', 'auto', 'auto', 'auto', 'en', 'ko']);
		expect(['auto', 'en', 'ko'].map((setting) => languageOf(parseReaderLanguage(setting)))).toEqual(['ko', 'en', 'ko']);
		fakeChrome('ja');
		expect(languageOf('auto')).toBe('en');
	});

	test('before a page follows the stored setting it speaks the browser language, then the setting, and a change applies at once', async () => {
		const chrome = fakeChrome('ko', { readerLanguage: 'en' });
		const { followReaderLanguage, language, t } = await freshI18n();
		const before = t('actionOn', 'example.org');
		const applied: string[] = [];
		await followReaderLanguage((setting) => void applied.push(`${setting}: ${t('popupSite')}`));
		await chrome.storage.sync.set({ readerLanguage: 'ko' });
		await vi.waitFor(() => expect(applied).toHaveLength(2));
		await chrome.storage.sync.set({ readerLanguage: 'auto' });
		await vi.waitFor(() => expect(applied).toHaveLength(3));
		expect(before).toBe('example.org에서 tfold가 켜져 있어요');
		expect(applied).toEqual(['en: Use on this site', 'ko: 이 사이트에서 사용', 'auto: 이 사이트에서 사용']);
		expect([language(), t('usageLeft', 72), t('trialLeft', 1)]).toEqual(['ko', '이번 달 남은 사용량 72%', '체험이 내일 끝나요']);
	});
});
