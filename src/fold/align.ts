// Derived from TextFold textfold/tokens.py (STOP, norm, lcs_pairs) and textfold/ladder.py (align) at commit 5fc941d
// (Apache-2.0). Changed for tfold: ported to TypeScript, atoms are left out, a written level aligns to the level
// above it (Key to Brief, Takeaway to Key), and the small words and punctuation that norm drops are matched by their
// exact text between two aligned words, so they slide with the words around them.

import { tokenize } from './local.ts';
import type { Fold } from './types.ts';

export type WordId = string & { readonly __brand: 'WordId' };
export type Word = { readonly id: WordId; readonly t: string };
export type Ladder = readonly [full: readonly Word[], brief: readonly Word[], key: readonly Word[], takeaway: readonly Word[]];

const stopWords = new Set([
	'the', 'a', 'an', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or',
	'that', 'this', 'these', 'those', 'it', 'its', 'for', 'on', 'with', 'as', 'by', 'at', 'from',
	'we', 'our', 'their', 'they', 'which', 'while', 'than', 'then', 'into', 'can', 'not', 'but',
	'such', 'also', 'has', 'have', 'had', 'does', 'do', 'more', 'most', 'less', 'only', 'both',
	'的', '了', '是', '在', '和', '与', '或', '这', '那', '就', '也', '都', '而', '及', '其', '之', '对', '中', '为',
]);

const notWordChar = /[^\p{L}\p{N}\p{M}_]/gu;

export function norm(t: string): string {
	const w = t.toLowerCase().replace(notWordChar, '');
	if (!w || stopWords.has(w)) return '';
	return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

export function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
	const n = a.length;
	const m = b.length;
	const width = m + 1;
	const dp = new Int32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] =
				a[i] && a[i] === b[j]
					? (dp[(i + 1) * width + j + 1] ?? 0) + 1
					: Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
		}
	}
	const pairs: [number, number][] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] && a[i] === b[j]) pairs.push([i++, j++]);
		else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) i++;
		else j++;
	}
	return pairs;
}

export function align(a: readonly string[], b: readonly string[]): [number, number][] {
	const exact = (words: readonly string[]) => words.map((t) => t.toLowerCase());
	const pairs: [number, number][] = [];
	let i = 0;
	let j = 0;
	for (const [ai, bj] of [...lcsPairs(a.map(norm), b.map(norm)), [a.length, b.length] as const]) {
		for (const [x, y] of lcsPairs(exact(a.slice(i, ai)), exact(b.slice(j, bj)))) pairs.push([i + x, j + y]);
		if (ai < a.length) pairs.push([ai, bj]);
		i = ai + 1;
		j = bj + 1;
	}
	return pairs;
}

export function sourceWords(text: string): Word[] {
	return tokenize(text).map((token, i) => ({ id: String(i) as WordId, t: token.t }));
}

function written(prefix: string, text: string, above: readonly Word[]): Word[] {
	const words = tokenize(text).map((token, j): Word => ({ id: `${prefix}${j}:${token.t}` as WordId, t: token.t }));
	for (const [i, j] of align(
		words.map((word) => word.t),
		above.map((word) => word.t),
	)) {
		const word = words[i];
		const source = above[j];
		if (word && source) words[i] = { id: source.id, t: word.t };
	}
	return words;
}

export function ladder(fold: Fold): Ladder {
	const full = sourceWords(fold.sentences.join(' '));
	const starts = [0];
	for (const sentence of fold.sentences) starts.push((starts.at(-1) ?? 0) + tokenize(sentence).length);
	const brief = fold.brief.flatMap((index) => full.slice(starts[index] ?? 0, starts[index + 1] ?? 0));
	const keptByKey = fold.writtenIn === undefined ? brief : [];
	const key = written('k', fold.key, keptByKey);
	return [full, brief, key, written('t', fold.takeaway, key)];
}
