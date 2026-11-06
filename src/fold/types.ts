import type { Language } from '../i18n.ts';

export const levels = [0, 1, 2, 3] as const;
export type Level = (typeof levels)[number];
export type FoldedLevel = Exclude<Level, 0>;

export function toLevel(n: number): Level | undefined {
	return levels.find((level) => level === n);
}

export type BlockId = string & { readonly __brand: 'BlockId' };

export type Block = {
	readonly id: BlockId;
	readonly el: Element;
	content: string;
	overlay: HTMLElement | null;
	level: Level;
};

export type Fold = {
	sentences: string[];
	brief: number[];
	key: string;
	takeaway: string;
	writtenIn?: Language;
};
