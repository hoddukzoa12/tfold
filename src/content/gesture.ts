import { toLevel, type BlockId } from '../fold/types.ts';
import { t } from '../i18n.ts';
import { comboOf, defaultScrollModifier, defaultShortcuts, onMac, sameCombo, type ScrollModifier, type Shortcuts } from '../shortcuts.ts';
import { canBeHit, columnOf, fetchRun, heldBlock, levelOf, nearestBlock, scan, setLevels, shownOf } from './blocks.ts';
import { advance, continues, foldsOnWheel, startGesture, stillCoasting, type Gesture } from './gesture-model.ts';
import { noteFold } from './hint.ts';
import { barIsUp, holdKindOf, keysOf, maxRun, nextHold, noHold, outlived, runOf, sweepOf, type Held, type Hold, type HoldEvent, type Run, type Sweep } from './hold-model.ts';
import { dialogIsOpen, focusedElement, isEditable, isFrame, keepsWheel, paragraphAt, type Point } from './target.ts';
import { lineFits, wakeBar, type Reading } from './target-bar.ts';

const modifierKeys = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift']);
// A press of Cmd+C or Cmd+Tab lands well inside this, so one key held alone shows nothing until it has stayed alone this long.
const holdBeatMs = 150;
const reaimMs = 150;
const rescanMs = 500;

let gesture: Gesture | undefined;
let claimedOnTheWayDown = false;
let wheelReachedHere = true;
let lastPlainWheel = -Infinity;
let controlHeld = false;
let pointer: Point | undefined;
let pointerMoved = false;
let stillSinceFold = false;
let keyTarget: BlockId | undefined;
let keyFocus: Element | null = null;
let shortcuts = defaultShortcuts;
let scrollModifier: ScrollModifier = defaultScrollModifier;
let hold: Hold = noHold;
let beat: ReturnType<typeof setTimeout> | undefined;
let keysSeenAt = -Infinity;
let scannedAt = -Infinity;
let aimed: { id: BlockId | undefined; at: number } | undefined;
let column: { anchor: BlockId; at: number; ids: readonly BlockId[] } | undefined;
let covered = { at: -Infinity, yes: false };

export function useShortcuts(next: Shortcuts): void {
	shortcuts = next;
}

export function useScrollModifier(next: ScrollModifier): void {
	scrollModifier = next;
}

function advanceHold(event: HoldEvent): void {
	const before = hold;
	hold = nextHold(hold, event);
	if (hold === before) return;
	aimed = undefined;
	if (hold.phase !== 'waiting') clearTimeout(beat);
	else if (before.phase !== 'waiting') beat = setTimeout(() => advanceHold({ type: 'settled' }), holdBeatMs);
	if (barIsUp(hold) && !barIsUp(before)) {
		const target = keyTargetStill();
		if (target) advanceHold({ type: 'over', id: target });
		else {
			pointerMoved = true;
			followPointer(performance.now());
		}
		wakeBar(markNow);
	}
}

const keyTargetStill = (): BlockId | undefined => (keyTarget !== undefined && keyFocus === document.activeElement && !dialogIsOpen() && canBeHit(keyTarget) ? keyTarget : undefined);

const hasSelection = () => document.getSelection()?.isCollapsed === false;

function noteHeld(held: Held, at: number): void {
	const kind = holdKindOf(held, shortcuts, scrollModifier);
	if (kind) keysSeenAt = at;
	advanceHold({ type: 'keys', kind: kind && !isEditable(focusedElement()) && !hasSelection() ? kind : undefined, how: 'seen' });
}

function rescanIfDue(now: number, afterMs: number): void {
	if (now - scannedAt <= afterMs) return;
	scannedAt = now;
	scan();
}

function paragraphUnderPointer(now: number, afterMs: number): BlockId | undefined {
	const under = pointer && document.elementFromPoint(pointer.x, pointer.y);
	if (!under) return undefined;
	const known = paragraphAt(under, heldBlock);
	if (known) return known;
	rescanIfDue(now, afterMs);
	return paragraphAt(under, heldBlock);
}

function columnNow(anchor: BlockId, now: number): readonly BlockId[] {
	const stale = column?.anchor !== anchor || (hold.phase !== 'folded' && now - column.at >= rescanMs);
	if (stale) column = { anchor, at: now, ids: columnOf(anchor) };
	return (column as NonNullable<typeof column>).ids;
}

const onPage = (id: BlockId): boolean => shownOf(id)?.isConnected === true;

const shownRun = (ids: readonly BlockId[]): Element[] => ids.filter(onPage).flatMap((id) => shownOf(id) ?? []);

// A block's id comes from what it says, so a page that renders its paragraphs again keeps the run, once a scan has found them.
function runNow(sweep: Sweep, now: number): Run {
	const run = runOf(sweep, columnNow(sweep.anchor, now));
	if (onPage(sweep.anchor) && run.ids.every(onPage)) return run;
	scan();
	column = undefined;
	return runOf(sweep, columnNow(sweep.anchor, now));
}

function followPointer(now: number): void {
	if (!pointerMoved) return;
	pointerMoved = false;
	const sweep = sweepOf(hold);
	if (hold.phase !== 'aiming' && hold.phase !== 'sweeping') return;
	const id = paragraphUnderPointer(now, rescanMs);
	if (id && (!sweep || columnNow(sweep.anchor, now).includes(id))) advanceHold({ type: 'over', id });
}

function holdingFocus(): BlockId | undefined {
	const focused = document.activeElement;
	if (!focused || focused === document.body || focused === document.documentElement) return undefined;
	return heldBlock(focused)?.id ?? nearestBlock({ within: focused });
}

function isCovered(anchor: BlockId, now: number, afterMs: number): boolean {
	if (now - covered.at >= Math.min(afterMs, reaimMs)) covered = { at: now, yes: dialogIsOpen() && !canBeHit(anchor) };
	return covered.yes;
}

// What the held keys' input folds with the pointer where it is. The bar marks this, and the wheel and the arrow fold it, so they
// cannot disagree. The wheel goes on as it began for a whole gesture, and it belongs to the scroll key, so only that key gives
// way to what keeps the wheel. A fold that moved the page under a pointer that stayed put does not change what the wheel folds.
function aimOf(now: number, afterMs: number): BlockId | undefined {
	const onWheelKey = keysOf(hold)?.kind === 'scroll-key';
	if (onWheelKey && continues(gesture, now)) return gesture.id;
	const under = paragraphUnderPointer(now, afterMs);
	if (onWheelKey && !under && !stillSinceFold && pointer && keepsWheel(pointer, scrollModifier)) return undefined;
	const sweep = sweepOf(hold);
	if (sweep) return isCovered(sweep.anchor, now, afterMs) ? undefined : sweep.anchor;
	const target = keyTargetStill();
	if (target) return target;
	if (under || dialogIsOpen()) return under;
	rescanIfDue(now, afterMs);
	return (pointer && nearestBlock({ toward: pointer, inColumn: true })) ?? holdingFocus() ?? nearestBlock({ toward: pointer });
}

function letGoUnseen(): void {
	controlHeld = false;
	advanceHold({ type: 'keys', kind: undefined, how: 'seen' });
}

function markNow(now: number): Reading {
	if (!barIsUp(hold)) return undefined;
	if (outlived(hold, keysSeenAt, now)) {
		letGoUnseen();
		return undefined;
	}
	followPointer(now);
	const before = sweepOf(hold);
	const run = before && runNow(before, now);
	if (before && !run?.ids.includes(before.anchor)) advanceHold({ type: 'gone' });
	if (!aimed || now - aimed.at > reaimMs) aimed = { id: aimOf(now, rescanMs), at: now };
	if (aimed.id === undefined) return 'searching';
	const sweep = sweepOf(hold);
	if (sweep && run) return { els: shownRun(run.ids), limit: run.capped ? { text: t('runLimit', maxRun), atTop: run.ids[0] !== sweep.anchor } : undefined };
	const el = shownOf(aimed.id);
	return el ? { els: [el] } : 'searching';
}

function runFrom(id: BlockId, now: number): readonly BlockId[] {
	const sweep = sweepOf(hold);
	return sweep?.anchor === id ? runNow(sweep, now).ids : [id];
}

// An input folds what the line marks, so where the line has nowhere to go it folds nothing and stays with the page.
function foldTarget(now: number): BlockId | undefined {
	const id = aimOf(now, 0);
	return id !== undefined && lineFits(shownRun(runFrom(id, now))) ? id : undefined;
}

// A whole run moves to the one level after the anchor's, so it stays uniform even when the anchor can go no further.
function foldRun(id: BlockId, direction: 1 | -1, ask: boolean, now: number): boolean {
	const run = runFrom(id, now);
	if (ask) fetchRun(run, id);
	const level = levelOf(id);
	const next = level === undefined ? undefined : (toLevel(level + direction) ?? (run.length > 1 ? level : undefined));
	if (next === undefined || !setLevels(run, next, id)) return false;
	advanceHold({ type: 'fold', id });
	stillSinceFold = true;
	if (direction > 0) noteFold();
	return true;
}

// A wheel before the bar shows is about a paragraph under it, or else the key means the browser's zoom or the page's own use,
// and stays that until let go. A page that took the wheel for itself has said the same.
function targetOfWheel({ defaultPrevented, clientX, clientY, timeStamp }: WheelEvent): BlockId | undefined {
	if (defaultPrevented && !claimedOnTheWayDown) {
		advanceHold({ type: 'used' });
		return undefined;
	}
	pointer ??= { x: clientX, y: clientY };
	followPointer(timeStamp);
	const under = paragraphUnderPointer(timeStamp, 0);
	if (hold.phase === 'waiting') advanceHold(under ? { type: 'settled' } : { type: 'used' });
	if (!barIsUp(hold)) return under;
	if (under && hold.phase === 'aiming') advanceHold({ type: 'over', id: under });
	return foldTarget(timeStamp);
}

export function onWheel(event: WheelEvent): void {
	if (!event.isTrusted) return;
	wheelReachedHere = true;
	const { ctrlKey, altKey, shiftKey, metaKey, timeStamp } = event;
	noteHeld({ ctrlKey: ctrlKey && controlHeld, altKey, shiftKey, metaKey }, timeStamp);
	// Keys that went on to mean something else, as in Cmd+C or Cmd+click, leave the wheel with the page too.
	const folding = foldsOnWheel(event, controlHeld, scrollModifier) && hold.phase !== 'spent';
	if (!folding || stillCoasting(timeStamp, lastPlainWheel, onMac)) {
		if (folding || (!ctrlKey && !altKey)) lastPlainWheel = timeStamp;
		gesture = undefined;
		keyTarget = undefined;
		return;
	}
	const current = continues(gesture, timeStamp) ? gesture : startGesture(targetOfWheel(event), timeStamp);
	// Chromium makes the rest of a wheel gesture cancelable only when its first event was canceled.
	if (current.id && event.cancelable) event.preventDefault();
	const advanced = advance(current, event.deltaY, timeStamp);
	gesture = advanced.gesture;
	if (current.id && advanced.step !== 0) foldRun(current.id, advanced.step, advanced.step > 0 && !current.stepped, timeStamp);
}

function directionOf(event: KeyboardEvent): 1 | -1 | undefined {
	const pressed = comboOf(event);
	if (sameCombo(pressed, shortcuts.fold)) return 1;
	return sameCombo(pressed, shortcuts.unfold) ? -1 : undefined;
}

function onKeyState(event: KeyboardEvent): void {
	if (!event.isTrusted) return;
	controlHeld = event.ctrlKey;
	const isModifier = modifierKeys.has(event.key);
	const isFoldKey = !isModifier && directionOf(event) !== undefined;
	if (event.type === 'keydown' && !isModifier && !isFoldKey) {
		advanceHold({ type: 'used' });
		return;
	}
	const kind = holdKindOf(event, shortcuts, scrollModifier);
	if (kind) keysSeenAt = event.timeStamp;
	const mayHold = kind && !event.isComposing && !isEditable(event.composedPath()[0]) && !hasSelection();
	advanceHold({ type: 'keys', kind: mayHold ? kind : undefined, how: event.type === 'keyup' ? 'released' : isFoldKey || !event.repeat ? 'pressed' : 'repeated' });
}

// A frame gets the pointer's moves from here on, so this is the last this page hears of where it went.
function onPointerOver({ isTrusted, target, clientX, clientY }: PointerEvent): void {
	if (!isTrusted || !isFrame(target)) return;
	pointer = { x: clientX, y: clientY };
	aimed = undefined;
}

// Chromium sends its own pointerout, with no keys set, when a change moves what is under a pointer that stayed put, so only a
// pointer move says which keys are held.
export function onPointer(event: PointerEvent): void {
	if (!event.isTrusted) return;
	if (event.type === 'pointerout') {
		if (event.relatedTarget === null) {
			pointer = undefined;
			keyTarget = undefined;
			advanceHold({ type: 'left' });
		}
		return;
	}
	controlHeld = event.ctrlKey;
	if (pointer?.x !== event.clientX || pointer.y !== event.clientY) {
		keyTarget = undefined;
		pointerMoved = true;
		stillSinceFold = false;
		if (!barIsUp(hold)) gesture = undefined;
	}
	pointer = { x: event.clientX, y: event.clientY };
	noteHeld(event, event.timeStamp);
}

function forgetKeys(): void {
	controlHeld = false;
	advanceHold({ type: 'away' });
}

function stopHolding(): void {
	controlHeld = false;
	clearTimeout(beat);
	hold = noHold;
}

export function onKeyDown(event: KeyboardEvent): void {
	if (!event.isTrusted || modifierKeys.has(event.key)) return;
	const direction = directionOf(event);
	if (direction === undefined || event.defaultPrevented || event.isComposing || isEditable(event.composedPath()[0]) || hasSelection()) {
		keyTarget = undefined;
		return;
	}
	followPointer(event.timeStamp);
	const sweep = sweepOf(hold);
	const id = foldTarget(event.timeStamp);
	// Pressed again with the keys let go, one paragraph stays the target however the page moved under a still pointer. The next
	// hold after a run, or after the pointer went elsewhere, starts from the pointer.
	keyTarget = !sweep || (sweep.anchor === sweep.head && (hold.phase !== 'folded' || stillSinceFold)) ? id : undefined;
	keyFocus = document.activeElement;
	if (id && foldRun(id, direction, direction > 0, event.timeStamp)) event.preventDefault();
}

export function listenForGestures(when: () => boolean, signal?: AbortSignal): void {
	const gated = <E extends Event>(handle: (event: E) => void) => (event: E) => {
		if (when()) handle(event);
	};
	// A copy from before this listener moved keeps running in a tab that was open across the update, and it claims on the way
	// down. That claim is not the page's, so only what happens after it counts. A wheel that never comes back up the page kept
	// for itself.
	addEventListener(
		'wheel',
		(event) => {
			claimedOnTheWayDown = event.defaultPrevented;
			if (!event.isTrusted || !barIsUp(hold)) return;
			wheelReachedHere = false;
			setTimeout(() => {
				if (!wheelReachedHere && when()) advanceHold({ type: 'used' });
			});
		},
		{ capture: true, passive: true, signal },
	);
	// On the way back up, so the page reads every wheel before tfold, and a page that takes it for itself has said so by then.
	addEventListener('wheel', gated(onWheel), { passive: false, signal });
	addEventListener('keydown', gated(onKeyDown), { signal });
	addEventListener('keydown', gated(onKeyState), { capture: true, signal });
	addEventListener('keyup', gated(onKeyState), { capture: true, signal });
	addEventListener('pointermove', gated(onPointer), { capture: true, passive: true, signal });
	addEventListener('pointerout', gated(onPointer), { capture: true, passive: true, signal });
	addEventListener('pointerover', gated(onPointerOver), { capture: true, passive: true, signal });
	addEventListener('pointerdown', gated(() => advanceHold({ type: 'used' })), { capture: true, passive: true, signal });
	signal?.addEventListener('abort', stopHolding);
	addEventListener('blur', forgetKeys, { signal });
	document.addEventListener('visibilitychange', forgetKeys, { signal });
}
