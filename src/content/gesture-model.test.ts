import { expect, test } from 'vitest';
import { advance, continues, foldsOnWheel, latchMs, scrollStep, startGesture, stillCoasting, type Gesture, type Step } from './gesture-model.ts';
import type { BlockId } from '../fold/types.ts';
import type { ScrollModifier } from '../shortcuts.ts';

const id = 'block' as BlockId;

function replay(target: BlockId | undefined, deltas: readonly number[], eventGapMs = 8): Step[] {
	let gesture: Gesture = startGesture(target, 0);
	return deltas.map((delta, i) => {
		const { gesture: next, step } = advance(gesture, delta, i * eventGapMs);
		gesture = next;
		return step;
	});
}

const levelsMoved = (steps: readonly Step[]) => steps.reduce<number>((sum, step) => sum + step, 0);

test.each([
	['a Windows notch', [100]],
	['a Linux notch', [53]],
	['a large notch', [120]],
	['a fast free-spinning wheel', [900]],
])('%s moves one level, whatever its size', (_, deltas) => {
	expect(levelsMoved(replay(id, deltas))).toBe(1);
});

test('two fingers on a Mac add up to the same distance as a notch', () => {
	const steps = replay(id, Array.from({ length: scrollStep / 5 }, () => 5));
	expect(levelsMoved(steps)).toBe(1);
	expect(steps.at(-1)).toBe(1);
});

test('a gesture knows when it has taken its first step', () => {
	const started = startGesture(id, 0);
	expect(started.stepped).toBe(false);
	const below = advance(started, scrollStep - 1, 8).gesture;
	expect(below.stepped).toBe(false);
	expect(advance(below, 1, 16).gesture.stepped).toBe(true);
});

test('scrolling down and back up within a gesture cancels out', () => {
	expect(levelsMoved(replay(id, [20, 10, -20, -10, 20, 10]))).toBe(0);
});

const held = (keys: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }>) => ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...keys });

test.each<[string, ReturnType<typeof held>, boolean, ScrollModifier, boolean]>([
	['Control with its key down and the Control setting folds', held({ ctrlKey: true }), true, 'ctrl', true],
	['Control with no key seen is a pinch and passes, whichever key is chosen', held({ ctrlKey: true }), false, 'ctrl', false],
	['a pinch passes with the Alt setting', held({ ctrlKey: true }), false, 'alt', false],
	['a pinch passes with the Cmd setting', held({ ctrlKey: true }), false, 'meta', false],
	['a pinch passes with scrolling off', held({ ctrlKey: true }), false, 'off', false],
	['a pinch passes while Cmd is held', held({ ctrlKey: true, metaKey: true }), false, 'meta', false],
	['a pinch passes while Alt is held', held({ ctrlKey: true, altKey: true }), false, 'alt', false],
	['Ctrl and scroll with the Alt setting stays with the browser', held({ ctrlKey: true }), true, 'alt', false],
	['Ctrl and scroll with the Cmd setting stays with the browser', held({ ctrlKey: true }), true, 'meta', false],
	['Ctrl and scroll with scrolling off stays with the browser', held({ ctrlKey: true }), true, 'off', false],
	['Alt and scroll with the Alt setting folds', held({ altKey: true }), false, 'alt', true],
	['Alt and scroll with the Control setting stays with the page', held({ altKey: true }), false, 'ctrl', false],
	['Cmd and scroll with the Cmd setting folds', held({ metaKey: true }), false, 'meta', true],
	['Cmd and scroll with the Control setting stays with the page', held({ metaKey: true }), false, 'ctrl', false],
	['a plain scroll stays with the page', held({}), false, 'ctrl', false],
	['a plain scroll stays with the page on a Mac', held({}), false, 'meta', false],
	['Shift and Ctrl and scroll, which scrolls sideways, stays', held({ ctrlKey: true, shiftKey: true }), true, 'ctrl', false],
	['Shift and Alt and scroll, which scrolls sideways, stays', held({ altKey: true, shiftKey: true }), false, 'alt', false],
	['Shift and Cmd and scroll, which scrolls sideways, stays', held({ metaKey: true, shiftKey: true }), false, 'meta', false],
])('%s', (_, keys, controlHeld, modifier, folds) => {
	expect(foldsOnWheel(keys, controlHeld, modifier)).toBe(folds);
});

test('a gesture that began over nothing never takes a step', () => {
	expect(levelsMoved(replay(undefined, [120, 120, 120]))).toBe(0);
});

test('on a Mac a wheel right after a plain scroll is still coasting, and elsewhere a held key means the gesture', () => {
	const lastPlain = 1000;
	expect(stillCoasting(lastPlain + latchMs - 1, lastPlain, true)).toBe(true);
	expect(stillCoasting(lastPlain + latchMs, lastPlain, true)).toBe(false);
	expect(stillCoasting(lastPlain + 1, lastPlain, false)).toBe(false);
});

test('a gesture continues across gaps inside the latch, and a new one starts after it', () => {
	const { gesture } = advance(startGesture(id, 0), 1, 100);
	expect(continues(gesture, 100 + latchMs)).toBe(true);
	expect(continues(gesture, 100 + latchMs + 1)).toBe(false);
	expect(continues(undefined, 0)).toBe(false);
});
