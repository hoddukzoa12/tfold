import { expect, test } from 'vitest';
import { ladder } from '../fold/align.ts';
import { countWords, tokenize } from '../fold/local.ts';
import { en } from './en.ts';
import { ko } from './ko.ts';

const words = (text: string) => tokenize(text).filter(({ t }) => /[\p{L}\p{N}]/u.test(t)).length;

test.each([
	['en', en.sampleFold],
	['ko', ko.sampleFold],
])('the %s sample folds through three shorter levels that keep shared words moving', (_, fold) => {
	const full = fold.sentences.join(' ');
	expect(countWords(full), 'long enough to count as a paragraph').toBeGreaterThanOrEqual(12);
	expect(fold.brief.every((index) => index >= 0 && index < fold.sentences.length)).toBe(true);
	const brief = fold.brief.map((index) => fold.sentences[index]).join(' ');
	expect(words(brief)).toBeLessThan(words(full));
	expect(words(fold.key)).toBeLessThan(words(brief));
	expect(words(fold.takeaway)).toBeLessThan(words(fold.key));
	const [, briefWords, keyWords, takeawayWords] = ladder(fold);
	const shared = (a: readonly { id: string }[], b: readonly { id: string }[]) => a.filter(({ id }) => b.some((word) => word.id === id)).length;
	expect(shared(keyWords, briefWords), 'key slides words from brief').toBeGreaterThanOrEqual(3);
	expect(shared(takeawayWords, keyWords), 'takeaway slides words from key').toBeGreaterThanOrEqual(3);
});

test('each language names all four levels', () => {
	for (const table of [en, ko]) {
		for (const level of [0, 1, 2, 3] as const) expect(table.sampleLevels[level].name.trim()).not.toBe('');
	}
});
