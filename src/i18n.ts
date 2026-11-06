import { en, enStore, type Strings } from './strings/en.ts';
import { ko, koStore } from './strings/ko.ts';

export type Language = 'en' | 'ko';
export type ReaderLanguage = 'auto' | Language;

type Key = keyof Strings;
type Args<M> = [M] extends [(...args: infer A) => unknown] ? A : [Extract<M, (...args: never[]) => unknown>] extends [never] ? [] : never;
type Result<M> = [M] extends [(...args: never[]) => infer R] ? R : M;
export type TextKey = { [K in Key]: Strings[K] extends string ? K : never }[Key];

export const readerLanguageKey = 'readerLanguage';

const storeTables: Record<Language, Strings> = {
	en: /* @__PURE__ */ Object.assign({}, en, enStore),
	ko: /* @__PURE__ */ Object.assign({}, ko, koStore),
};

export const browserLanguage = (): Language => (/^ko\b/i.test(chrome.i18n.getUILanguage()) ? 'ko' : 'en');

export const parseReaderLanguage = (raw: unknown): ReaderLanguage => (raw === 'en' || raw === 'ko' ? raw : 'auto');

export const languageOf = (setting: ReaderLanguage): Language => (setting === 'auto' ? browserLanguage() : setting);

export const readReaderLanguage = async (): Promise<ReaderLanguage> =>
	parseReaderLanguage((await chrome.storage.sync.get(readerLanguageKey))[readerLanguageKey]);

// The bundler removes every line that names a store string from the open edition, so its tables go without them.
export const stringsIn = (language: Language): Strings => (TFOLD_EDITION === 'store' ? storeTables[language] : ({ en, ko } as Record<Language, Strings>)[language]);

let current: Language | undefined;

export const language = (): Language => (current ??= browserLanguage());

export function t<K extends Key>(key: K, ...args: Args<Strings[K]>): Result<Strings[K]> {
	const message = stringsIn(language())[key];
	return (typeof message === 'function' ? (message as (...args: unknown[]) => unknown)(...args) : message) as Result<Strings[K]>;
}

export function showKeys(cap: Element, keys: string): void {
	cap.textContent = keys;
	cap.setAttribute('role', 'img');
	cap.setAttribute('aria-label', keys.replaceAll('+', ' ').replace(/[↓↑←→]/gu, (arrow) => t('arrowNames')[arrow] ?? arrow));
}

export function localize(): void {
	document.documentElement.lang = language();
	for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as TextKey);
}

// A content script that Chrome cuts off keeps chrome.storage and chrome.i18n, and each call throws, so that script passes
// live and nothing here calls them once it says no. A read on its way when the cut comes can fail, and nobody needs its answer.
export async function followReaderLanguage(apply: (setting: ReaderLanguage) => void | Promise<void> = () => {}, live: () => boolean = () => true): Promise<void> {
	const read = async () => {
		try {
			const setting = await readReaderLanguage();
			if (!live()) return;
			current = languageOf(setting);
			await apply(setting);
		} catch (error) {
			if (live()) throw error;
		}
	};
	chrome.storage.onChanged.addListener((changes, area) => {
		if (live() && area === 'sync' && readerLanguageKey in changes) void read();
	});
	await read();
}
