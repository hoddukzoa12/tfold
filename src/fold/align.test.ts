import { expect, test } from 'vitest';
import { align, ladder, lcsPairs, norm, sourceWords, type Word } from './align.ts';
import { tokenize } from './local.ts';

const words = (text: string) => tokenize(text).map((token) => token.t);
const normed = (text: string) => words(text).map(norm);
const ids = (level: readonly Word[]) => level.map((word) => word.id);
const pairsOf = (level: readonly Word[]) => level.map((word) => `${word.t}=${word.id}`);

test('norm drops small words and punctuation, folds case and a plural s, as textfold does', () => {
	expect(['Holes', 'glass', 'The', 'was', 'its', 'black,', 'gas', 'bus', 'Ἀρχή'].map(norm)).toEqual([
		'hole',
		'glass',
		'',
		'',
		'',
		'black',
		'gas',
		'bus',
		'ἀρχή',
	]);
});

test('lcsPairs matches textfold on a reordered word: the word out of order is left unmatched', () => {
	expect(lcsPairs(normed('light cannot escape a black hole'), normed('black holes trap light, so nothing escapes'))).toEqual([
		[4, 0],
		[5, 1],
	]);
	expect(lcsPairs(normed('Gravity bends light around stars'), normed('Stars bend light; gravity bends it more'))).toEqual([
		[1, 1],
		[2, 2],
	]);
});

test('lcsPairs matches textfold on a repeated word: each copy pairs with one copy, in order', () => {
	expect(lcsPairs(normed('the hole beside the hole'), normed('a hole is a hole'))).toEqual([
		[1, 1],
		[4, 4],
	]);
	expect(lcsPairs(normed('hole hole'), normed('a black hole'))).toEqual([[1, 2]]);
});

test('lcsPairs never matches an empty word', () => {
	expect(lcsPairs(['', 'a', ''], ['', 'a', ''])).toEqual([[1, 1]]);
	expect(lcsPairs([], ['a'])).toEqual([]);
});

test('align also matches the small words and punctuation between two matched words', () => {
	const key = words('Objects whose gravity is too strong for light, first considered.');
	const brief = words('Objects whose gravitational fields are too strong for light to escape were first considered in the 18th century.');
	const matched = align(key, brief).map(([i, j]) => `${key[i]}=${brief[j]}`);
	expect(matched).toEqual([
		'Objects=Objects',
		'whose=whose',
		'too=too',
		'strong=strong',
		'for=for',
		'light=light',
		'first=first',
		'considered=considered',
		'.=.',
	]);
});

test('ladder: Brief keeps the source ids of the sentences it keeps', () => {
	const fold = {
		sentences: ['A black hole bends light.', 'Nothing escapes it.', 'Its edge is the event horizon.'],
		brief: [0, 2],
		key: '',
		takeaway: '',
	};
	const [full, brief] = ladder(fold);
	expect(ids(full)).toEqual(sourceWords(fold.sentences.join(' ')).map((word) => word.id));
	expect(pairsOf(brief)).toEqual([
		'A=0',
		'black=1',
		'hole=2',
		'bends=3',
		'light=4',
		'.=5',
		'Its=10',
		'edge=11',
		'is=12',
		'the=13',
		'event=14',
		'horizon=15',
		'.=16',
	]);
});

test('ladder: Key words found in Brief take their ids, and model-written words get ids of their own', () => {
	const [, , key, takeaway] = ladder({
		sentences: ['The gravity of a black hole traps light completely.', 'Astronomers infer black holes from orbits.'],
		brief: [0],
		key: 'Extreme gravity traps all light.',
		takeaway: 'Extreme gravity traps light',
	});
	expect(pairsOf(key)).toEqual(['Extreme=k0:Extreme', 'gravity=1', 'traps=6', 'all=k3:all', 'light=7', '.=9']);
	expect(pairsOf(takeaway)).toEqual(['Extreme=k0:Extreme', 'gravity=1', 'traps=6', 'light=7']);
});

test('ladder: a reordered Key word keeps no id, so it fades in while the words around it slide', () => {
	const [, , key] = ladder({
		sentences: ['Light cannot escape a black hole.'],
		brief: [0],
		key: 'A black hole traps light.',
		takeaway: '',
	});
	expect(pairsOf(key)).toEqual(['A=3', 'black=4', 'hole=5', 'traps=k3:traps', 'light=k4:light', '.=6']);
});

test('ladder: a repeated word takes the id of one copy, the first that keeps the order', () => {
	const [, , key] = ladder({
		sentences: ['The hole beside the hole is dark.'],
		brief: [0],
		key: 'The second hole is dark.',
		takeaway: '',
	});
	expect(pairsOf(key)).toEqual(['The=0', 'second=k1:second', 'hole=1', 'is=5', 'dark=6', '.=7']);
});

test('ladder: Korean words keep their ids from Full through Brief, Key and Takeaway', () => {
	const [full, brief, key, takeaway] = ladder({
		sentences: ['블랙홀은 빛조차 빠져나올 수 없는 천체이다.', '일반 상대성 이론이 그 존재를 예측했다.'],
		brief: [0],
		key: '블랙홀은 빛조차 빠져나올 수 없다. 일반 상대성 이론이 예측했다.',
		takeaway: '블랙홀은 빛조차 빠져나올 수 없다',
	});
	expect(pairsOf(brief)).toEqual(full.slice(0, 7).map((word) => `${word.t}=${word.id}`));
	expect(pairsOf(key).slice(0, 4)).toEqual(['블랙홀은=0', '빛조차=1', '빠져나올=2', '수=3']);
	expect(pairsOf(takeaway).slice(0, 4)).toEqual(['블랙홀은=0', '빛조차=1', '빠져나올=2', '수=3']);
	expect(new Set(ids(key)).size).toBe(key.length);
});

test('ladder: a Key translated into the reader language takes no Brief id, even for a name it keeps, and Takeaway still takes the Key ids', () => {
	const [, brief, key, takeaway] = ladder({
		sentences: ['On July 20, 1969, Neil Armstrong landed on the Moon.', 'He spent two hours outside.'],
		brief: [0],
		key: 'Neil Armstrong(닐 암스트롱)은 1969년 7월 20일 달에 착륙했다. 그는 두 시간 밖에 있었다.',
		takeaway: 'Neil Armstrong(닐 암스트롱)은 1969년 7월 20일 달에 착륙했다',
		writtenIn: 'ko',
	});
	expect(ids(key).filter((id) => ids(brief).includes(id))).toEqual([]);
	expect(ids(takeaway)).toEqual(ids(key).slice(0, takeaway.length));
});

test('ladder: Takeaway words that open the Key keep the Key ids, small words and punctuation included', () => {
	const fold = {
		sentences: ['The quick brown fox jumps over the lazy dog.'],
		brief: [0],
		key: 'The quick fox jumps over the dog, as foxes do.',
		takeaway: 'The quick fox jumps over the dog',
	};
	const [, , key, takeaway] = ladder(fold);
	expect(ids(takeaway)).toEqual(ids(key).slice(0, takeaway.length));
});
