import { expect, test } from 'vitest';
import { countWords, localFold } from './local.ts';

const sentences = (text: string) => localFold(text).sentences;

test('English splits at stops, but not after an abbreviation, an initial or inside a number', () => {
	expect(sentences('Dr. Smith met J. Doe at 3 p.m. on Monday. The rain fell at 3.5 mm per hour! Did it stop? Yes.')).toEqual([
		'Dr. Smith met J. Doe at 3 p.m. on Monday.',
		'The rain fell at 3.5 mm per hour!',
		'Did it stop?',
		'Yes.',
	]);
});

test.each([
	['a capital name after a.m.', 'The meeting began at 9 a.m. Monday in the main hall. Everyone came on time.', ['The meeting began at 9 a.m. Monday in the main hall.', 'Everyone came on time.']],
	['a number after p.m.', 'Doors open at 6 p.m. 12 seats remain for the talk. Bring a friend.', ['Doors open at 6 p.m. 12 seats remain for the talk.', 'Bring a friend.']],
	['a word that opens a sentence', 'The bus left at 7 a.m. The driver waved at us. Nobody waved back.', ['The bus left at 7 a.m.', 'The driver waved at us.', 'Nobody waved back.']],
	['the last word of the text', 'The bus left at 7 a.m.', ['The bus left at 7 a.m.']],
	['a capital initialism', 'She moved to the U.S. Later that year she left. Nobody knew why.', ['She moved to the U.S. Later that year she left.', 'Nobody knew why.']],
	['Hangul after a.m.', '회의는 오전 9 a.m. 정각에 시작했어요. 다들 제시간에 왔어요.', ['회의는 오전 9 a.m. 정각에 시작했어요.', '다들 제시간에 왔어요.']],
	['Hangul after p.m., with a Latin name', 'Samsung은 3 p.m. 뉴욕에서 발표했어요. 주가는 올랐어요.', ['Samsung은 3 p.m. 뉴욕에서 발표했어요.', '주가는 올랐어요.']],
])('a dotted initialism does not end the sentence: %s', (_, text, expected) => {
	expect(sentences(text)).toEqual(expected);
});

test('English keeps closing quotes and brackets with the sentence they end', () => {
	expect(sentences('She said "stop." Then she left (quietly.) Nobody saw her go.')).toEqual([
		'She said "stop."',
		'Then she left (quietly.)',
		'Nobody saw her go.',
	]);
});

test('a sentence that opens with a superscript or a formula in TeX still splits from the one before', () => {
	expect(sentences('Carbon dating relies on slow decay. ^14C has a half-life of 5,730 years.')).toEqual([
		'Carbon dating relies on slow decay.',
		'^14C has a half-life of 5,730 years.',
	]);
	expect(sentences('The plate heats up. \\Delta T grows with the current. {\\frac {1}{2}}mv^2 is the energy.')).toEqual([
		'The plate heats up.',
		'\\Delta T grows with the current.',
		'{\\frac {1}{2}}mv^2 is the energy.',
	]);
});

test('Korean splits at stops even though Hangul has no capital letters', () => {
	expect(sentences('블랙홀은 빛조차 빠져나올 수 없는 천체입니다. 일반 상대성 이론이 그 존재를 예측했습니다! 정말 그럴까요? 네.')).toEqual([
		'블랙홀은 빛조차 빠져나올 수 없는 천체입니다.',
		'일반 상대성 이론이 그 존재를 예측했습니다!',
		'정말 그럴까요?',
		'네.',
	]);
});

test('Chinese splits at full-width stops with no spaces between sentences', () => {
	expect(sentences('黑洞是一种天体。它的引力极强，连光都无法逃脱！科学家仍在研究它吗？是的。')).toEqual([
		'黑洞是一种天体。',
		'它的引力极强，连光都无法逃脱！',
		'科学家仍在研究它吗？',
		'是的。',
	]);
});

test('Chinese does not split after a heading number such as 1.', () => {
	expect(sentences('1.研究背景介绍了问题。然后是方法。')).toEqual(['1.研究背景介绍了问题。', '然后是方法。']);
});

test('Brief keeps sentence 0, Key its first 22 words and Takeaway its first 14 words', () => {
	const first =
		'Objects whose gravitational fields are too strong for light to escape were first considered in the 18th century by two natural philosophers working on their own in England and France.';
	const fold = localFold(`${first} In 1916, the first solution of general relativity was found.`);
	expect(fold.brief).toEqual([0]);
	expect(fold.sentences).toEqual([first, 'In 1916, the first solution of general relativity was found.']);
	expect(fold.key).toBe(
		'Objects whose gravitational fields are too strong for light to escape were first considered in the 18th century by two natural philosophers…',
	);
	expect(fold.takeaway).toBe('Objects whose gravitational fields are too strong for light to escape were first considered…');
});

test('Key and Takeaway never grow past Brief, and a cut only at the final stop adds no ellipsis', () => {
	const short = localFold('A short first sentence with exactly fourteen words in it, as the test needs. Then more text follows here.');
	expect(short.key).toBe('A short first sentence with exactly fourteen words in it, as the test needs.');
	expect(short.takeaway).toBe('A short first sentence with exactly fourteen words in it, as the test needs.');
});

test('Takeaway counts each Chinese character as a word', () => {
	const fold = localFold('黑洞是一种引力极强的天体，连光都无法从它的事件视界逃脱。第二句。');
	expect(fold.takeaway).toBe('黑洞是一种引力极强的天体，连光…');
});

test('countWords counts words, not punctuation, and stops at the limit', () => {
	expect(countWords('One, two; three - four.')).toBe(4);
	expect(countWords('a b c d e f g h i j k l m n o p', 12)).toBe(12);
	expect(countWords('천체입니다 일반 상대성')).toBe(3);
});
