import type { BlockId } from '../fold/types.ts';
import type { ScrollModifier } from '../shortcuts.ts';
import { onlyScrollKey, type Held } from './hold-model.ts';

export const latchMs = 400;
export const scrollStep = 50;

export type Step = -1 | 0 | 1;

// What was under a wheel gesture when it began holds for the whole gesture: a paragraph, or nothing, which leaves it to the page.
export type Gesture = { id: BlockId | undefined; until: number; sum: number; stepped: boolean };

// Chromium sends a trackpad pinch as wheel events with Control set and no Control key down, and that belongs to the browser.
// So a Control the page never saw go down is a pinch, even when it really was the key: passing it through costs one zoom.
export const foldsOnWheel = (held: Held, controlHeld: boolean, key: ScrollModifier): boolean => onlyScrollKey(held, key) && (key !== 'ctrl' || controlHeld);

// A Mac keeps sending an inertial scroll after the fingers lift, with the key set once it is pressed, as it is for
// Control+Tab or Cmd+Tab. Elsewhere a wheel has no inertia, and a reader who scrolls and then holds a key means the gesture.
export const stillCoasting = (at: number, lastPlainWheel: number, mac: boolean): boolean => mac && at - lastPlainWheel < latchMs;

export const continues = (gesture: Gesture | undefined, at: number): gesture is Gesture => gesture !== undefined && at <= gesture.until;

export const startGesture = (id: BlockId | undefined, at: number): Gesture => ({ id, until: at + latchMs, sum: 0, stepped: false });

export function advance(gesture: Gesture, deltaY: number, at: number): { gesture: Gesture; step: Step } {
	const until = at + latchMs;
	if (gesture.id === undefined) return { gesture: { ...gesture, until }, step: 0 };
	const sum = gesture.sum + deltaY;
	if (Math.abs(sum) < scrollStep) return { gesture: { ...gesture, until, sum }, step: 0 };
	return { gesture: { ...gesture, until, sum: 0, stepped: true }, step: sum > 0 ? 1 : -1 };
}
