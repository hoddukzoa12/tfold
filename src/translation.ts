import { languageOf, parseReaderLanguage, readerLanguageKey, type Language } from './i18n.ts';

export const autoTranslateKey = 'autoTranslate';
export const translationKeys = [autoTranslateKey, readerLanguageKey] as const;
export type StoredTranslation = Partial<Record<(typeof translationKeys)[number], unknown>>;

// On unless the reader turned it off, so a reader who switched it off keeps that choice.
export const parseAutoTranslate = (raw: unknown): boolean => raw !== false;

export function translationTarget(stored: StoredTranslation): Language | undefined {
	return parseAutoTranslate(stored[autoTranslateKey]) ? languageOf(parseReaderLanguage(stored[readerLanguageKey])) : undefined;
}
