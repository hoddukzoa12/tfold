import { afterEach, expect, test, vi } from 'vitest';
import { defaultShortcuts, heldName, label, parseShortcuts, problemWith, scrollLabel, type Combo } from './shortcuts.ts';

type Held = Partial<Omit<Combo, 'code'>>;

const combo = (code: string, held: Held = {}): Combo => ({ code, ctrl: false, alt: false, shift: false, meta: false, ...held });

test('the default shortcuts read as Option+Shift+Down and Up on a Mac and Alt+Shift elsewhere', () => {
	expect([label(defaultShortcuts.fold, true), label(defaultShortcuts.unfold, true)]).toEqual(['Option+Shift+↓', 'Option+Shift+↑']);
	expect([label(defaultShortcuts.fold, false), label(defaultShortcuts.unfold, false)]).toEqual(['Alt+Shift+↓', 'Alt+Shift+↑']);
	expect(label(combo('KeyJ', { ctrl: true, meta: true }), true)).toBe('Control+Cmd+J');
	expect(label(combo('Digit2', { ctrl: true, shift: true }), false)).toBe('Ctrl+Shift+2');
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

test('an untouched scroll key is Cmd on a Mac and Ctrl elsewhere, and a stored choice stays on either', async () => {
	vi.stubGlobal('navigator', { platform: 'MacIntel' });
	vi.resetModules();
	const mac = await import('./shortcuts.ts');
	expect(mac.parseScrollModifier(undefined)).toBe('meta');
	expect(mac.parseScrollModifier('nonsense')).toBe('meta');
	expect(['ctrl', 'alt', 'off', 'meta'].map((key) => mac.parseScrollModifier(key))).toEqual(['ctrl', 'alt', 'off', 'meta']);

	vi.stubGlobal('navigator', { platform: 'Linux x86_64' });
	vi.resetModules();
	const other = await import('./shortcuts.ts');
	expect(other.parseScrollModifier(undefined)).toBe('ctrl');
	expect(other.parseScrollModifier('alt')).toBe('alt');
});

test('the scroll key reads as Cmd on a Mac, in every place a key is named', () => {
	expect(heldName('meta', true)).toBe('Cmd');
	expect(scrollLabel('meta', true, 'scroll', '↓ ↑')).toBe('Cmd+scroll ↓ ↑');
	expect(label(combo('KeyK', { shift: true, meta: true }), true)).toBe('Shift+Cmd+K');
});

const fold = (code: string, held: Held) => problemWith({ fold: combo(code, held), unfold: defaultShortcuts.unfold });

test('a shortcut holds Shift and one of Ctrl, Alt or Meta with an arrow, a letter or a digit', () => {
	expect(problemWith(defaultShortcuts)).toBeUndefined();
	expect(fold('KeyJ', { alt: true, shift: true })).toBeUndefined();
	expect(fold('Digit7', { ctrl: true, shift: true })).toBeUndefined();
	expect(fold('ArrowLeft', { ctrl: true, alt: true, shift: true })).toBeUndefined();
	expect(fold('KeyK', { shift: true, meta: true })).toBeUndefined();
	expect(fold('ArrowDown', { alt: true, shift: true, meta: true })).toBeUndefined();
});

test('a shortcut without Shift and another held key is refused, so typing and single-modifier browser keys stay', () => {
	const refused: [string, Held][] = [
		['KeyJ', {}],
		['ArrowDown', { shift: true }],
		['KeyF', { ctrl: true }],
		['KeyD', { ctrl: true }],
		['KeyP', { ctrl: true }],
		['KeyS', { ctrl: true }],
		['KeyL', { ctrl: true }],
		['ArrowDown', { ctrl: true }],
		['ArrowLeft', { alt: true }],
		['KeyF', { alt: true }],
		['KeyE', { alt: true }],
		['ArrowDown', { alt: true }],
		['KeyJ', { alt: true }],
		['KeyF', { meta: true }],
		['KeyJ', { ctrl: true, alt: true }],
		['KeyI', { alt: true, meta: true }],
		['KeyJ', { alt: true, meta: true }],
		['KeyC', { alt: true, meta: true }],
	];
	for (const [code, held] of refused) expect([code, held, fold(code, held)]).toEqual([code, held, 'modifiers']);
});

test('a shortcut on a key other than an arrow, a letter or a digit is refused', () => {
	for (const code of ['Equal', 'Minus', 'Tab', 'Delete', 'Enter', 'Space', 'PageDown', 'F5', 'BracketLeft', 'Numpad1']) {
		expect([code, fold(code, { ctrl: true, shift: true })]).toEqual([code, 'key']);
	}
});

test('a shortcut Chrome or the system already uses is refused', () => {
	const refused: [string, Held][] = [
		...['KeyT', 'KeyN', 'KeyW', 'KeyB', 'KeyO', 'KeyJ', 'KeyI', 'KeyC', 'KeyM', 'KeyA', 'KeyR', 'KeyD', 'KeyG'].map(
			(code): [string, Held] => [code, { ctrl: true, shift: true }],
		),
		...['KeyT', 'KeyN', 'KeyW', 'KeyB', 'KeyJ', 'KeyI', 'KeyC', 'KeyA', 'KeyM', 'KeyR', 'KeyD', 'KeyH', 'KeyG', 'KeyQ', 'Digit3', 'Digit4', 'Digit5', 'KeyS', 'ArrowLeft'].map(
			(code): [string, Held] => [code, { shift: true, meta: true }],
		),
		['KeyI', { alt: true, shift: true }],
		['KeyA', { alt: true, shift: true }],
		['KeyT', { alt: true, shift: true }],
		['KeyI', { alt: true, shift: true, meta: true }],
	];
	for (const [code, held] of refused) expect([code, held, fold(code, held)]).toEqual([code, held, 'taken']);
});

test('fold and unfold must differ, and either one can be the refused shortcut', () => {
	expect(problemWith({ fold: defaultShortcuts.unfold, unfold: defaultShortcuts.unfold })).toBe('same');
	expect(problemWith({ fold: defaultShortcuts.fold, unfold: combo('KeyF', { ctrl: true }) })).toBe('modifiers');
	expect(problemWith({ fold: defaultShortcuts.fold, unfold: combo('KeyT', { ctrl: true, shift: true }) })).toBe('taken');
});

test('stored shortcuts parse only when they are whole and allowed', () => {
	const rebound = { fold: combo('KeyJ', { alt: true, shift: true }), unfold: combo('KeyK', { alt: true, shift: true }) };
	expect(parseShortcuts(JSON.parse(JSON.stringify(rebound)))).toEqual(rebound);
	expect(parseShortcuts(undefined)).toBeUndefined();
	expect(parseShortcuts({ fold: rebound.fold })).toBeUndefined();
	expect(parseShortcuts({ ...rebound, fold: { ...rebound.fold, alt: 'yes' } })).toBeUndefined();
	expect(parseShortcuts({ ...rebound, fold: combo('ShiftLeft', { alt: true }) })).toBeUndefined();
	expect(parseShortcuts({ ...rebound, fold: combo('', { alt: true }) })).toBeUndefined();
	expect(parseShortcuts({ ...rebound, fold: combo('KeyJ') })).toBeUndefined();
	expect(parseShortcuts({ ...rebound, fold: combo('KeyJ', { alt: true }) })).toBeUndefined();
	expect(parseShortcuts({ ...rebound, fold: combo('KeyT', { ctrl: true, shift: true }) })).toBeUndefined();
	expect(parseShortcuts({ fold: rebound.fold, unfold: rebound.fold })).toBeUndefined();
});
