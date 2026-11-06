import { languageOf, parseReaderLanguage, readerLanguageKey, type Language } from './i18n.ts';

export const autoTranslateKey = 'autoTranslate';
export const translationKeys = [autoTranslateKey, readerLanguageKey] as const;
export type StoredTranslation = Partial<Record<(typeof translationKeys)[number], unknown>>;

export const parseAutoTranslate = (raw: unknown): boolean => raw === true;

export function translationTarget(stored: StoredTranslation): Language | undefined {
	return parseAutoTranslate(stored[autoTranslateKey]) ? languageOf(parseReaderLanguage(stored[readerLanguageKey])) : undefined;
}
