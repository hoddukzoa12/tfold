// Derived from TextFold textfold/tokens.py at commit 5fc941d (Apache-2.0), tokenize_text and split_sentences.
// Changed for tfold: ported to TypeScript, cut to plain-text tokens without Thai syllables, and a letter from a
// script without capitals (such as Hangul) can open the next sentence, so Korean text splits.

import type { Fold } from './types.ts';

export type Token = { t: string; s: boolean; at: number };

const cjk = String.raw`\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f`;
const letter = String.raw`(?:(?![${cjk}])[\p{L}\p{N}])`;
const letterRun = String.raw`${letter}(?:${letter}|\p{M})*`;
const piece = new RegExp(
	String.raw`\s+|[${cjk}]|\p{Nd}+(?:[.,]\p{Nd}+)+%?|${letterRun}(?:['’\-]${letterRun})*|\S`,
	'gu',
);
export const cjkChar = new RegExp(`[${cjk}]`, 'u');
const wordChar = /[\p{L}\p{N}]/u;
const sentenceHead = /^[\p{Lu}\p{Lo}\p{Nd}([“"‘^_\\{]/u;

const abbreviations = new Set([
	'e', 'g', 'i', 'al', 'etc', 'vs', 'cf', 'fig', 'figs', 'eq', 'eqs', 'sec', 'secs', 'tab',
	'ref', 'refs', 'no', 'approx', 'resp', 'ca', 'viz', 'dr', 'mr', 'ms', 'prof', 'st', 'jr',
	'inc', 'ltd', 'co', 'appx', 'app', 'thm', 'def', 'lem', 'prop', 'cor', 'ch',
]);
const sentenceOpeners = new Set([
	'a', 'after', 'an', 'and', 'as', 'at', 'before', 'but', 'by', 'for', 'he', 'her', 'his', 'however', 'i', 'if', 'in',
	'it', 'its', 'my', 'on', 'our', 'she', 'so', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'those',
	'to', 'we', 'when', 'while', 'you',
]);
const cjkStops = new Set(['。', '！', '？']);
const dandas = new Set(['।', '॥']);
const stops = new Set(['.', '?', '!', ...cjkStops, ...dandas]);
const closers = new Set([')', ']', '}', '）', '］', '｝', '】', '〕', '〉', '》', '」', '』', '”', '"', '’', "'"]);
const tails = new Set([...stops, ...closers]);

const keyWords = 22;
const takeawayWords = 14;

export function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	for (const { 0: match, index } of text.matchAll(piece)) {
		const last = tokens.at(-1);
		if (/^\s/u.test(match)) {
			if (last) last.s = true;
		} else {
			tokens.push({ t: match, s: false, at: index });
		}
	}
	return tokens;
}

const isWord = (token: Token) => wordChar.test(token.t);

export function countWords(text: string, limit = Infinity): number {
	let count = 0;
	for (const [match] of text.matchAll(piece)) if (wordChar.test(match) && ++count >= limit) break;
	return count;
}

function closesInitialism(tokens: Token[], stop: number): boolean {
	const letterBefore = tokens[stop - 1];
	const dotBefore = tokens[stop - 2];
	if (!letterBefore || !dotBefore || dotBefore.t !== '.' || dotBefore.s || letterBefore.s || !/^\p{L}$/u.test(letterBefore.t)) return false;
	return /^\p{L}$/u.test(tokens[stop - 3]?.t ?? '') && !sentenceOpeners.has((tokens[stop + 1]?.t ?? '').toLowerCase());
}

function splitSentences(tokens: Token[]): [number, number][] {
	const bounds: [number, number][] = [];
	const n = tokens.length;
	let start = 0;
	for (let i = 0; i < n; i++) {
		const t = tokens[i]?.t ?? '';
		if (i < start || !stops.has(t)) continue;
		const prev = tokens[i - 1]?.t ?? '';
		if (t === '.' && (abbreviations.has(prev.toLowerCase()) || /^[A-Z]$/.test(prev) || closesInitialism(tokens, i))) continue;
		let end = i + 1;
		while (end < n && !tokens[end - 1]?.s && tails.has(tokens[end]?.t ?? '')) end++;
		if (end >= n) break;
		const head = tokens[end]?.t ?? '';
		const run = tokens.slice(i, end).map((token) => token.t);
		let cjkEnd = run.some((stop) => cjkStops.has(stop)) || cjkChar.test(prev) || cjkChar.test(head);
		if (cjkEnd && t === '.' && i === start + 1 && /^\p{Nd}+$/u.test(prev)) cjkEnd = false;
		const dandaEnd = run.some((stop) => dandas.has(stop));
		if (cjkEnd || dandaEnd || (tokens[end - 1]?.s && sentenceHead.test(head))) {
			bounds.push([start, end]);
			start = end;
		}
	}
	if (start < n) bounds.push([start, n]);
	return bounds;
}

function join(tokens: Token[]): string {
	return tokens.map((token, i) => (token.s && i < tokens.length - 1 ? `${token.t} ` : token.t)).join('');
}

function firstWords(tokens: Token[], words: number): string {
	let seen = 0;
	const end = tokens.findIndex((token) => isWord(token) && ++seen === words) + 1;
	return end === 0 || !tokens.slice(end).some(isWord) ? join(tokens) : `${join(tokens.slice(0, end))}…`;
}

export function localFold(text: string): Fold {
	const tokens = tokenize(text);
	const ranges = splitSentences(tokens);
	const [briefStart, briefEnd] = ranges[0] ?? [0, 0];
	const brief = tokens.slice(briefStart, briefEnd);
	return {
		sentences: ranges.map(([start, end]) => join(tokens.slice(start, end))),
		brief: [0],
		key: firstWords(brief, keyWords),
		takeaway: firstWords(brief, takeawayWords),
	};
}
