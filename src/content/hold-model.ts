import type { BlockId } from '../fold/types.ts';
import type { Combo, ScrollModifier, Shortcuts } from '../shortcuts.ts';

// Measured at 5, 10 and 20 on a long article: 2, 3 and 4 calls, or 2, 6 and 9 translated, and one first frame of about 130, 150
// and 170 ms against about 80 for one paragraph, because only what shows animates. Past 20 the calls keep growing and the far
// end of the run is out of sight.
export const maxRun = 20;

export type Held = { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };
export type HoldKind = 'shortcut' | 'scroll-key';

export type Sweep = { anchor: BlockId; head: BlockId };

// Which input the keys belong to, and whether this page heard a key event for them. A hold it only read from pointer and wheel
// events gets no let-go, so it lasts only as long as those keep confirming it.
export type HeldKeys = { kind: HoldKind; heard: boolean };

// Off: no key is held. Spent: the keys held meant something else, as Cmd+C does, and count again only once let go.
// Waiting: one key alone is held, which could still be Cmd+C. Aiming: the bar marks the nearest paragraph and nothing is
// chosen yet. Sweeping: the head follows the pointer. Folded: a fold moved the page, so the run stays as it is until let go.
export type Hold =
	| { phase: 'off' }
	| { phase: 'spent' }
	| { phase: 'waiting' | 'aiming'; keys: HeldKeys }
	| { phase: 'sweeping' | 'folded'; keys: HeldKeys; sweep: Sweep };

// How the keys came to be known: a key going down, one repeating, a sighting on a pointer or wheel event, or a key coming up.
export type KeysSeen = 'pressed' | 'repeated' | 'seen' | 'released';

export type HoldEvent =
	| { type: 'keys'; kind: HoldKind | undefined; how: KeysSeen }
	| { type: 'settled' }
	| { type: 'used' }
	| { type: 'away' }
	| { type: 'left' }
	| { type: 'over'; id: BlockId }
	| { type: 'fold'; id: BlockId }
	| { type: 'gone' };

export const noHold: Hold = { phase: 'off' };
const spent: Hold = { phase: 'spent' };

// Long enough for the gaps in a slow sweep, and short enough that a bar whose end this page cannot see goes about when the
// reader lets go. A guess until it is tried on a Mac.
export const unheardKeysMs = 500;

const sameHeld = (held: Held, { ctrl, alt, shift, meta }: Combo): boolean => held.ctrlKey === ctrl && held.altKey === alt && held.shiftKey === shift && held.metaKey === meta;

const scrollKeyField = { ctrl: 'ctrlKey', alt: 'altKey', meta: 'metaKey' } as const;

export const onlyScrollKey = (held: Held, key: ScrollModifier): boolean =>
	key !== 'off' && (['ctrlKey', 'altKey', 'shiftKey', 'metaKey'] as const).every((name) => held[name] === (name === scrollKeyField[key]));

export function holdKindOf(held: Held, { fold, unfold }: Shortcuts, scrollKey: ScrollModifier): HoldKind | undefined {
	if (sameHeld(held, fold) || sameHeld(held, unfold)) return 'shortcut';
	return onlyScrollKey(held, scrollKey) ? 'scroll-key' : undefined;
}

export const barIsUp = ({ phase }: Hold): boolean => phase === 'aiming' || phase === 'sweeping' || phase === 'folded';

export const sweepOf = (hold: Hold): Sweep | undefined => (hold.phase === 'sweeping' || hold.phase === 'folded' ? hold.sweep : undefined);

export const keysOf = (hold: Hold): HeldKeys | undefined => (hold.phase === 'off' || hold.phase === 'spent' ? undefined : hold.keys);

export function outlived(hold: Hold, lastSeenAt: number, now: number): boolean {
	const keys = keysOf(hold);
	return keys !== undefined && !keys.heard && now - lastSeenAt > unheardKeysMs;
}

// A key coming up never starts a hold, so what is left of a chord such as Cmd+Shift+G shows nothing.
function keysChanged(hold: Hold, kind: HoldKind | undefined, how: KeysSeen): Hold {
	if (kind === undefined) return noHold;
	if (hold.phase === 'spent' && how !== 'pressed') return hold;
	if (hold.phase === 'off' && how === 'released') return hold;
	const before = keysOf(hold);
	const keys = { kind, heard: how !== 'seen' || before?.heard === true };
	if (hold.phase === 'off' || hold.phase === 'spent' || hold.phase === 'waiting') {
		if (kind === 'shortcut') return { phase: 'aiming', keys };
		return hold.phase === 'waiting' && before?.heard === keys.heard ? hold : { phase: 'waiting', keys };
	}
	return before?.kind === kind && before.heard === keys.heard ? hold : { ...hold, keys };
}

export function nextHold(hold: Hold, event: HoldEvent): Hold {
	switch (event.type) {
		case 'keys':
			return keysChanged(hold, event.kind, event.how);
		case 'settled':
			return hold.phase === 'waiting' ? { phase: 'aiming', keys: hold.keys } : hold;
		case 'used':
		case 'away':
			return hold.phase === 'off' ? hold : spent;
		case 'left':
			return keysOf(hold)?.heard === false ? noHold : hold;
		case 'over':
			if (hold.phase === 'aiming') return { ...hold, phase: 'sweeping', sweep: { anchor: event.id, head: event.id } };
			return hold.phase === 'sweeping' && hold.sweep.head !== event.id ? { ...hold, sweep: { ...hold.sweep, head: event.id } } : hold;
		case 'fold':
			if (hold.phase === 'aiming') return { ...hold, phase: 'folded', sweep: { anchor: event.id, head: event.id } };
			return hold.phase === 'sweeping' ? { ...hold, phase: 'folded' } : hold;
		case 'gone':
			return hold.phase === 'sweeping' || hold.phase === 'folded' ? { phase: 'aiming', keys: hold.keys } : hold;
	}
}

export type Run = { ids: readonly BlockId[]; capped: boolean };

// The blocks of the anchor's column from the anchor to the head, in reading order, and never past the cap from the anchor.
export function runOf({ anchor, head }: Sweep, column: readonly BlockId[], cap: number = maxRun): Run {
	const from = column.indexOf(anchor);
	if (from < 0) return { ids: [], capped: false };
	const found = column.indexOf(head);
	const to = found < 0 ? from : found;
	const reach = Math.min(Math.abs(to - from), cap - 1);
	const capped = reach < Math.abs(to - from);
	return { ids: to >= from ? column.slice(from, from + reach + 1) : column.slice(from - reach, from + 1), capped };
}
