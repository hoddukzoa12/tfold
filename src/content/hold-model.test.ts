import { describe, expect, test } from 'vitest';
import type { BlockId } from '../fold/types.ts';
import { defaultShortcuts } from '../shortcuts.ts';
import { barIsUp, holdKindOf, keysOf, maxRun, nextHold, noHold, outlived, runOf, sweepOf, unheardKeysMs, type Hold, type HoldEvent, type KeysSeen, type Sweep } from './hold-model.ts';

const b = (n: number) => `b${n}` as BlockId;
const column = Array.from({ length: 40 }, (_, i) => b(i));
const sweep = (anchor: number, head: number): Sweep => ({ anchor: b(anchor), head: b(head) });
const replay = (events: HoldEvent[], from: Hold = noHold): Hold => events.reduce(nextHold, from);

const held = (keys: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...keys });
const keys = (kind: 'shortcut' | 'scroll-key' | undefined, how: KeysSeen = 'pressed'): HoldEvent => ({ type: 'keys', kind, how });
const over = (n: number): HoldEvent => ({ type: 'over', id: b(n) });
const fold = (n: number): HoldEvent => ({ type: 'fold', id: b(n) });

describe('the run between the anchor and the head', () => {
	const ids = (a: number, h: number, within: readonly BlockId[] = column, cap = maxRun) => runOf(sweep(a, h), within, cap).ids;

	test('moving onto a later paragraph extends the run, and it reads top to bottom', () => {
		expect(ids(3, 3)).toEqual([b(3)]);
		expect(ids(3, 5)).toEqual([b(3), b(4), b(5)]);
	});

	test('moving back toward the anchor shrinks it, and past the anchor it selects upward with the anchor last', () => {
		expect(ids(3, 4)).toEqual([b(3), b(4)]);
		expect(ids(3, 2)).toEqual([b(2), b(3)]);
		expect(ids(3, 0)).toEqual([b(0), b(1), b(2), b(3)]);
	});

	test('a jump across many paragraphs takes in every one between', () => {
		expect(ids(2, 9)).toHaveLength(8);
		expect(ids(9, 2)).toHaveLength(8);
		expect(ids(2, 9)).toEqual(column.slice(2, 10));
	});

	test('what is not in the column is skipped, so a heading or an image between two paragraphs never joins', () => {
		const withoutHeading = [b(0), b(1), b(3), b(4)];
		expect(ids(0, 4, withoutHeading)).toEqual(withoutHeading);
	});

	test('a head outside the column leaves the anchor alone, and an anchor outside it leaves nothing', () => {
		expect(ids(1, 99, column.slice(0, 5))).toEqual([b(1)]);
		expect(ids(99, 1, column.slice(0, 5))).toEqual([]);
	});

	test('the cap counts from the anchor, in either direction, and says when it cut the run', () => {
		expect(runOf(sweep(5, 9), column, 5)).toEqual({ ids: column.slice(5, 10), capped: false });
		expect(runOf(sweep(5, 10), column, 5)).toEqual({ ids: column.slice(5, 10), capped: true });
		expect(runOf(sweep(10, 6), column, 5)).toEqual({ ids: column.slice(6, 11), capped: false });
		expect(runOf(sweep(10, 5), column, 5)).toEqual({ ids: column.slice(6, 11), capped: true });
	});

	test('the shipped cap holds exactly that many', () => {
		expect(runOf(sweep(0, 39), column).ids).toHaveLength(maxRun);
		expect(runOf(sweep(0, maxRun - 1), column).capped).toBe(false);
		expect(runOf(sweep(0, maxRun), column).capped).toBe(true);
	});
});

describe('which keys count as a hold', () => {
	const { fold: foldKeys } = defaultShortcuts;
	const rebound = { fold: { ...foldKeys, code: 'KeyK', alt: false, ctrl: true }, unfold: { ...foldKeys, code: 'KeyJ', alt: false, ctrl: true } };

	test('the modifiers of the shortcut count at once', () => {
		expect(holdKindOf(held({ altKey: true, shiftKey: true }), defaultShortcuts, 'meta')).toBe('shortcut');
	});

	test('a rebound shortcut moves the hold with it', () => {
		expect(holdKindOf(held({ ctrlKey: true, shiftKey: true }), rebound, 'meta')).toBe('shortcut');
		expect(holdKindOf(held({ altKey: true, shiftKey: true }), rebound, 'meta')).toBeUndefined();
	});

	test.each([
		['meta', held({ metaKey: true })],
		['ctrl', held({ ctrlKey: true })],
		['alt', held({ altKey: true })],
	] as const)('the %s scroll key alone counts as the key that waits', (key, keysHeld) => {
		expect(holdKindOf(keysHeld, defaultShortcuts, key)).toBe('scroll-key');
	});

	test('a scroll key with anything else, another key alone, nothing, and off all count for nothing', () => {
		expect(holdKindOf(held({ metaKey: true, shiftKey: true }), defaultShortcuts, 'meta')).toBeUndefined();
		expect(holdKindOf(held({ metaKey: true, ctrlKey: true }), defaultShortcuts, 'meta')).toBeUndefined();
		expect(holdKindOf(held({ ctrlKey: true }), defaultShortcuts, 'meta')).toBeUndefined();
		expect(holdKindOf(held({ shiftKey: true }), defaultShortcuts, 'meta')).toBeUndefined();
		expect(holdKindOf(held(), defaultShortcuts, 'meta')).toBeUndefined();
		expect(holdKindOf(held({ metaKey: true }), defaultShortcuts, 'off')).toBeUndefined();
	});
});

describe('the bar comes up and goes away', () => {
	test('the modifiers of a shortcut bring it up at once', () => {
		expect(barIsUp(replay([keys('shortcut')]))).toBe(true);
	});

	test('one key alone waits, and only the wait passing brings it up', () => {
		expect(replay([keys('scroll-key')]).phase).toBe('waiting');
		expect(barIsUp(replay([keys('scroll-key')]))).toBe(false);
		expect(barIsUp(replay([keys('scroll-key'), { type: 'settled' }]))).toBe(true);
	});

	test('a key held alone, then the rest of a shortcut, brings it up at once', () => {
		expect(barIsUp(replay([keys('scroll-key'), keys('shortcut')]))).toBe(true);
	});

	test('Cmd+C shows nothing: another key before the wait ends it, the wait passing changes nothing, and Cmd held on stays spent', () => {
		const pressed = replay([keys('scroll-key'), { type: 'used' }]);
		expect(pressed.phase).toBe('spent');
		expect(replay([{ type: 'settled' }], pressed).phase).toBe('spent');
		expect(replay([keys('scroll-key', 'seen')], pressed).phase).toBe('spent');
		expect(replay([keys('scroll-key', 'released')], pressed).phase).toBe('spent');
	});

	test('a key coming up never starts a hold, so what is left of a chord shows nothing, while a sighting on the pointer can', () => {
		expect(replay([keys(undefined), keys('scroll-key', 'released')])).toBe(noHold);
		expect(replay([keys(undefined), keys('shortcut', 'released')])).toBe(noHold);
		expect(replay([keys('scroll-key', 'seen')]).phase).toBe('waiting');
		expect(barIsUp(replay([keys('shortcut', 'seen')]))).toBe(true);
	});

	test('another key while the bar shows takes it away at once', () => {
		expect(barIsUp(replay([keys('shortcut'), over(1), { type: 'used' }]))).toBe(false);
	});

	test('Cmd+Tab shows nothing: the page losing focus spends the wait', () => {
		expect(replay([keys('scroll-key'), { type: 'away' }]).phase).toBe('spent');
		expect(replay([keys('scroll-key'), { type: 'away' }, { type: 'settled' }]).phase).toBe('spent');
	});

	test('losing focus with nothing held spends nothing, so a press made elsewhere still counts when the pointer comes in', () => {
		expect(replay([{ type: 'away' }]).phase).toBe('off');
		expect(barIsUp(replay([{ type: 'away' }, keys('shortcut', 'seen')]))).toBe(true);
		expect(replay([{ type: 'used' }]).phase).toBe('off');
	});

	test('a spent hold counts again only after a let-go or a fresh press', () => {
		const pressed = replay([keys('shortcut'), { type: 'away' }]);
		expect(replay([keys('shortcut', 'seen')], pressed).phase).toBe('spent');
		expect(replay([keys(undefined, 'released')], pressed).phase).toBe('off');
		expect(barIsUp(replay([keys('shortcut', 'pressed')], pressed))).toBe(true);
		expect(replay([keys('scroll-key', 'pressed')], pressed).phase).toBe('waiting');
	});

	test('letting go ends every phase, and what was chosen with it', () => {
		const phases: HoldEvent[][] = [[keys('scroll-key')], [keys('shortcut')], [keys('shortcut'), over(1)], [keys('shortcut'), over(1), fold(1)], [keys('shortcut'), { type: 'used' }]];
		for (const events of phases) expect(replay([...events, keys(undefined, 'released')])).toBe(noHold);
	});

	test('keys that change from one kind of hold to another keep what was chosen, and the hold then belongs to the other input', () => {
		const sweeping = replay([keys('shortcut'), over(1), over(3)]);
		const changed = replay([keys('scroll-key', 'released')], sweeping);
		expect(sweepOf(changed)).toEqual(sweep(1, 3));
		expect(keysOf(changed)?.kind).toBe('scroll-key');
	});

	test('a hold read only from pointer and wheel events lasts as long as they keep confirming it', () => {
		const seen = replay([keys('shortcut', 'seen'), over(1)]);
		expect(outlived(seen, 1000, 1000 + unheardKeysMs)).toBe(false);
		expect(outlived(seen, 1000, 1000 + unheardKeysMs + 1)).toBe(true);
		expect(outlived(replay([keys('scroll-key', 'seen')]), 1000, 1000 + unheardKeysMs + 1), 'waiting too').toBe(true);
	});

	test.each(['pressed', 'repeated', 'released'] as const)('a key event of any kind, %s, proves the page hears the keys, so nothing has to keep confirming them', (how) => {
		const seen = replay([keys('shortcut', 'seen')]);
		expect(outlived(replay([keys('shortcut', how)], seen), 0, 1e9)).toBe(false);
		expect(outlived(replay([keys('shortcut', how), keys('shortcut', 'seen')], seen), 0, 1e9), 'and a later sighting does not take that back').toBe(false);
	});

	test('a sighting after the wait began does not make up for a key the page never heard', () => {
		const waiting = replay([keys('scroll-key', 'seen'), keys('scroll-key', 'seen')]);
		expect(outlived(replay([{ type: 'settled' }], waiting), 0, 1e9)).toBe(true);
		expect(outlived(replay([keys('scroll-key'), { type: 'settled' }]), 0, 1e9), 'a press carries through the wait').toBe(false);
	});

	test('the pointer leaving the window ends only a hold the page never heard', () => {
		expect(replay([keys('shortcut', 'seen'), over(1), { type: 'left' }])).toBe(noHold);
		expect(replay([keys('scroll-key', 'seen'), { type: 'left' }])).toBe(noHold);
		expect(sweepOf(replay([keys('shortcut'), over(1), { type: 'left' }]))).toEqual(sweep(1, 1));
	});

	test('off and spent have nothing to outlive', () => {
		expect(outlived(noHold, 0, 1e9)).toBe(false);
		expect(outlived(replay([keys('shortcut', 'seen'), { type: 'used' }]), 0, 1e9)).toBe(false);
	});

	test('nothing that does not change the phase makes a new state, so the bar is not woken for it', () => {
		const sweeping = replay([keys('shortcut'), over(1)]);
		expect(nextHold(sweeping, over(1))).toBe(sweeping);
		expect(nextHold(noHold, { type: 'settled' })).toBe(noHold);
		expect(nextHold(noHold, { type: 'gone' })).toBe(noHold);
	});
});

describe('what a sweep follows', () => {
	test('the first paragraph under the pointer becomes the anchor and the head', () => {
		expect(sweepOf(replay([keys('shortcut'), over(4)]))).toEqual(sweep(4, 4));
	});

	test('later paragraphs move only the head', () => {
		expect(sweepOf(replay([keys('shortcut'), over(4), over(7), over(2)]))).toEqual(sweep(4, 2));
	});

	test('a sweep needs the bar to be up', () => {
		expect(sweepOf(replay([over(4)]))).toBeUndefined();
		expect(sweepOf(replay([keys('scroll-key'), over(4)]))).toBeUndefined();
		expect(sweepOf(replay([keys('shortcut'), { type: 'used' }, over(4)]))).toBeUndefined();
	});

	test('a fold fixes the run, so the pointer ending up on another paragraph changes nothing until the keys are let go', () => {
		const folded = replay([keys('shortcut'), over(4), over(6), fold(4)]);
		expect(folded.phase).toBe('folded');
		expect(sweepOf(replay([over(9)], folded))).toEqual(sweep(4, 6));
		expect(sweepOf(replay([fold(4)], folded))).toEqual(sweep(4, 6));
	});

	test('a fold with the bar on the nearest paragraph chooses that paragraph', () => {
		const folded = replay([keys('shortcut'), fold(8)]);
		expect(folded.phase).toBe('folded');
		expect(sweepOf(folded)).toEqual(sweep(8, 8));
	});

	test('a fold with no hold chooses nothing', () => {
		expect(replay([fold(8)])).toBe(noHold);
	});

	test('an anchor that left the page sends the bar back to the nearest paragraph', () => {
		expect(replay([keys('shortcut'), over(4), { type: 'gone' }]).phase).toBe('aiming');
		expect(replay([keys('shortcut'), over(4), fold(4), { type: 'gone' }]).phase).toBe('aiming');
	});
});
