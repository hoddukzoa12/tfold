import { afterEach, expect, test, vi } from 'vitest';
import { translationTarget } from '../translation.ts';
import { paragraphLanguage, translateFor } from './language.ts';

const english = 'Sam Altman leads OpenAI, which released GPT-4 in March 2023 after training it on Azure supercomputers.';
const french = 'La tour Eiffel, construite pour l’Exposition universelle de 1889, devait être démontée après vingt ans.';
const german = 'Der Bundestag hat am Donnerstag ein Gesetz beschlossen, das die Förderung von Wärmepumpen verlängert.';
const spanish = 'El Museo del Prado, inaugurado en 1819 en Madrid, guarda una de las colecciones de pintura más completas.';
const korean = 'React 18에서 useEffect는 StrictMode일 때 개발 모드에서 두 번 실행되고, 이는 cleanup 함수의 버그를 드러낸다.';
const englishWithKorean = 'Bong Joon-ho filmed 기생충 in Seoul, and it won the Palme d’Or at Cannes in May 2019 before its Oscars.';
const japanese = '東京大学の研究チームは、新しい量子コンピューターの試作機を公開した。';
const chinese = '黑洞是时空的一个区域，其引力强大到任何物质和辐射都无法逃脱。';
const russian = 'Чёрная дыра — область пространства-времени.';

const known = (lang: string) => ({ known: true, lang });
const latin = { known: false, script: 'latin' };

function chromeLanguage(uiLanguage: string): void {
	vi.stubGlobal('chrome', { i18n: { getUILanguage: () => uiLanguage } });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test('without a lang, Hangul, Kana and Han name their language, and Latin letters name none', () => {
	expect(paragraphLanguage('', korean)).toEqual(known('ko'));
	expect(paragraphLanguage('', japanese)).toEqual(known('ja'));
	expect(paragraphLanguage('', chinese)).toEqual(known('zh'));
	for (const text of [english, french, german, spanish, englishWithKorean]) expect(paragraphLanguage('', text)).toEqual(latin);
	expect(paragraphLanguage('', russian)).toEqual({ known: false, script: undefined });
});

test('a declared lang names the language when the words can be written in it, and a script that rules it out leaves only what the script proves', () => {
	expect(paragraphLanguage('en-GB', english)).toEqual(known('en'));
	expect(paragraphLanguage('fr', french)).toEqual(known('fr'));
	expect(paragraphLanguage('de', german)).toEqual(known('de'));
	expect(paragraphLanguage('es', spanish)).toEqual(known('es'));
	expect(paragraphLanguage('ko', korean)).toEqual(known('ko'));
	expect(paragraphLanguage('en', korean)).toEqual(known('ko'));
	expect(paragraphLanguage('zh', japanese)).toEqual(known('zh'));
	expect(paragraphLanguage('ru', russian)).toEqual(known('ru'));
	expect(paragraphLanguage('ko', english)).toEqual(latin);
	expect(paragraphLanguage('ja', french)).toEqual(latin);
});

test('Korean that leans on English terms is Korean, and English that glosses a few Korean words is not', () => {
	const koreanWithTerms = 'Kubernetes에서 Horizontal Pod Autoscaler는 CPU utilization, memory pressure, custom metrics를 보고 Deployment replica 수를 조절한다.';
	const englishGlossary = 'In Korean, 사랑 means love, 친구 means friend, 학교 means school, and 감사합니다 means thank you.';
	expect(paragraphLanguage('', koreanWithTerms)).toEqual(known('ko'));
	expect(paragraphLanguage('en', koreanWithTerms)).toEqual(known('ko'));
	expect(paragraphLanguage('', englishGlossary)).toEqual(latin);
	expect(paragraphLanguage('en', englishGlossary)).toEqual(known('en'));
	expect(translateFor(paragraphLanguage('', koreanWithTerms), 'ko')).toBeUndefined();
	expect(translateFor(paragraphLanguage('', englishGlossary), 'ko')).toBe('ko');
});

test('a paragraph is translated only when it is provably not in the reader language', () => {
	const toKorean = (declared: string, text: string) => translateFor(paragraphLanguage(declared, text), 'ko');
	const toEnglish = (declared: string, text: string) => translateFor(paragraphLanguage(declared, text), 'en');
	for (const text of [english, french, german, spanish, englishWithKorean, japanese, russian]) expect(toKorean('', text)).toBe('ko');
	expect(toKorean('', korean)).toBeUndefined();
	expect(toKorean('ko', korean)).toBeUndefined();
	for (const text of [english, french, german, spanish, englishWithKorean]) expect(toEnglish('', text)).toBeUndefined();
	expect(toEnglish('en', english)).toBeUndefined();
	expect(toEnglish('fr', french)).toBe('en');
	expect(toEnglish('de', german)).toBe('en');
	expect(toEnglish('', korean)).toBe('en');
	expect(toEnglish('', japanese)).toBe('en');
	expect(toEnglish('', russian)).toBe('en');
	expect(translateFor(paragraphLanguage('', french), undefined)).toBeUndefined();
});

test('auto-translate is on unless stored as false, and the Auto reader language follows Chrome', () => {
	chromeLanguage('ko-KR');
	expect(translationTarget({})).toBe('ko');
	expect(translationTarget({ autoTranslate: false, readerLanguage: 'ko' })).toBeUndefined();
	expect(translationTarget({ autoTranslate: false })).toBeUndefined();
	expect(translationTarget({ autoTranslate: true })).toBe('ko');
	expect(translationTarget({ autoTranslate: true, readerLanguage: 'en' })).toBe('en');
	chromeLanguage('en-US');
	expect(translationTarget({ autoTranslate: true, readerLanguage: 'auto' })).toBe('en');
	expect(translationTarget({ autoTranslate: true, readerLanguage: 'ko' })).toBe('ko');
	expect(translationTarget({ autoTranslate: true, readerLanguage: 'fr' })).toBe('en');
});
