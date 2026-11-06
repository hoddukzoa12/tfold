import type { Language } from '../i18n.ts';
import { tokenize } from './local.ts';

type Script = 'hangul' | 'kana' | 'han' | 'latin';

export type TextLanguage = { known: true; lang: string } | { known: false; script: Script | undefined };

const scriptsByPriority: [Script, RegExp][] = [
	['hangul', /\p{Script=Hangul}/u],
	['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
	['han', /\p{Script=Han}/u],
	['latin', /\p{Script=Latin}/u],
];
const languageOfScript: Partial<Record<Script, string>> = { hangul: 'ko', kana: 'ja', han: 'zh' };
const nonLatinLanguages: Record<string, Script> = { ko: 'hangul', ja: 'kana', zh: 'han' };
const letter = /\p{L}/u;

const scriptOfWord = (word: string) => scriptsByPriority.find(([, pattern]) => pattern.test(word))?.[0];
const scriptOfLanguage = (language: string): Script => nonLatinLanguages[language] ?? 'latin';
const isCjkScript = (script: Script) => script === 'kana' || script === 'han';

function scriptOf(text: string): Script | undefined {
	const words = tokenize(text).filter((token) => letter.test(token.t));
	if (words.length === 0) return undefined;
	const share = (script: Script) => words.filter(({ t }) => scriptOfWord(t) === script).length / words.length;
	if (share('hangul') >= 0.3) return 'hangul';
	if (share('kana') + share('han') >= 0.3) return share('kana') >= 0.05 ? 'kana' : 'han';
	return share('latin') >= 0.5 ? 'latin' : undefined;
}

function fits(language: string, script: Script): boolean {
	const declared = scriptOfLanguage(language);
	return declared === script || (isCjkScript(declared) && isCjkScript(script));
}

export function paragraphLanguage(declared: string, text: string): TextLanguage {
	const tag = declared.trim().toLowerCase().split('-')[0] ?? '';
	const script = scriptOf(text);
	if (tag !== '' && (script === undefined || fits(tag, script))) return { known: true, lang: tag };
	const lang = script && languageOfScript[script];
	return lang ? { known: true, lang } : { known: false, script };
}

export function translateFor(language: TextLanguage, reader: Language | undefined): Language | undefined {
	if (reader === undefined) return undefined;
	const other = language.known ? language.lang !== reader : language.script !== scriptOfLanguage(reader);
	return other ? reader : undefined;
}
