export type Combo = { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
export type Shortcuts = { fold: Combo; unfold: Combo };
export type Problem = 'modifiers' | 'key' | 'taken' | 'same';

export const defaultShortcuts: Shortcuts = {
	fold: { code: 'ArrowDown', ctrl: false, alt: true, shift: true, meta: false },
	unfold: { code: 'ArrowUp', ctrl: false, alt: true, shift: true, meta: false },
};

export const onMac = /Mac|iPhone|iPad/.test(navigator.platform);

const keyCode = /^[A-Z][A-Za-z0-9]*$/;
const modifierCode = /^((Alt|Control|Meta|OS|Shift)(Left|Right)|AltGraph|CapsLock|Fn|FnLock|NumLock|ScrollLock)$/;

const keyNames: Record<string, string> = {
	ArrowDown: '↓',
	ArrowUp: '↑',
	ArrowLeft: '←',
	ArrowRight: '→',
	PageDown: 'Page Down',
	PageUp: 'Page Up',
	Escape: 'Esc',
	Backquote: '`',
	Minus: '-',
	Equal: '=',
	BracketLeft: '[',
	BracketRight: ']',
	Backslash: '\\',
	Semicolon: ';',
	Quote: "'",
	Comma: ',',
	Period: '.',
	Slash: '/',
};

export const comboOf = (event: KeyboardEvent): Combo => ({
	code: event.code,
	ctrl: event.ctrlKey,
	alt: event.altKey,
	shift: event.shiftKey,
	meta: event.metaKey,
});

export const sameCombo = (a: Combo, b: Combo): boolean =>
	a.code === b.code && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta;

const modifiers = [
	['ctrl', 'Control', 'Ctrl'],
	['alt', 'Option', 'Alt'],
	['shift', 'Shift', 'Shift'],
	['meta', 'Cmd', 'Meta'],
] as const;

const held = (combo: Combo): string =>
	modifiers
		.filter(([name]) => combo[name])
		.map(([name]) => name)
		.join('+');

const allowedKey = /^(Arrow(Up|Down|Left|Right)|Key[A-Z]|Digit[0-9])$/;

// Shortcuts inside the allowed set that Chrome or the system already uses on Mac, Windows or Linux, from
// support.google.com/chrome/answer/157179, developer.chrome.com/docs/devtools/shortcuts, Chrome's tab search,
// and the macOS and Windows screenshot and window shortcuts.
const taken = new Set(
	Object.entries({
		'ctrl+shift': 'KeyA KeyB KeyC KeyD KeyG KeyH KeyI KeyJ KeyM KeyN KeyO KeyR KeyT KeyW',
		'alt+shift': 'KeyA KeyI KeyN KeyT',
		'shift+meta': 'KeyA KeyB KeyC KeyD KeyG KeyH KeyI KeyJ KeyM KeyN KeyQ KeyR KeyS KeyT KeyW Digit3 Digit4 Digit5 Digit6 ArrowUp ArrowDown ArrowLeft ArrowRight',
		'alt+shift+meta': 'KeyA KeyI',
	}).flatMap(([mods, codes]) => codes.split(' ').map((code) => `${mods}+${code}`)),
);

function problemWithCombo(combo: Combo): Problem | undefined {
	if (!combo.shift || !(combo.ctrl || combo.alt || combo.meta)) return 'modifiers';
	if (!allowedKey.test(combo.code)) return 'key';
	return taken.has(`${held(combo)}+${combo.code}`) ? 'taken' : undefined;
}

export function problemWith({ fold, unfold }: Shortcuts): Problem | undefined {
	return problemWithCombo(fold) ?? problemWithCombo(unfold) ?? (sameCombo(fold, unfold) ? 'same' : undefined);
}

export const isModifierCode = (code: string): boolean => modifierCode.test(code);

function parseCombo(raw: unknown): Combo | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const { code, ctrl, alt, shift, meta } = raw as Record<string, unknown>;
	if (typeof code !== 'string' || !keyCode.test(code) || isModifierCode(code)) return undefined;
	if (typeof ctrl !== 'boolean' || typeof alt !== 'boolean' || typeof shift !== 'boolean' || typeof meta !== 'boolean') return undefined;
	return { code, ctrl, alt, shift, meta };
}

export function parseShortcuts(raw: unknown): Shortcuts | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const stored = raw as Record<string, unknown>;
	const fold = parseCombo(stored.fold);
	const unfold = parseCombo(stored.unfold);
	if (!fold || !unfold) return undefined;
	return problemWith({ fold, unfold }) === undefined ? { fold, unfold } : undefined;
}

export const scrollModifiers = ['meta', 'ctrl', 'alt', 'off'] as const;
export type ScrollModifier = (typeof scrollModifiers)[number];
export type HeldForScroll = Exclude<ScrollModifier, 'off'>;

// Chrome's own list of Mac shortcuts gives Command and the wheel no action.
export const defaultScrollModifier: ScrollModifier = onMac ? 'meta' : 'ctrl';

export const parseScrollModifier = (raw: unknown): ScrollModifier => scrollModifiers.find((modifier) => modifier === raw) ?? defaultScrollModifier;

const heldNames: Record<HeldForScroll, { mac: string; other: string }> = {
	meta: { mac: 'Cmd', other: 'Meta' },
	ctrl: { mac: 'Control', other: 'Ctrl' },
	alt: { mac: 'Option', other: 'Alt' },
};

export const heldName = (modifier: HeldForScroll, mac: boolean): string => heldNames[modifier][mac ? 'mac' : 'other'];

export const scrollLabel = (modifier: HeldForScroll, mac: boolean, word: string, arrows = ''): string =>
	`${heldName(modifier, mac)}+${word}${arrows === '' ? '' : ` ${arrows}`}`;

export function label(combo: Combo, mac: boolean): string {
	const key = keyNames[combo.code] ?? combo.code.replace(/^(Key|Digit)/, '');
	const held = modifiers.filter(([name]) => combo[name]).map(([, macName, name]) => (mac ? macName : name));
	return [...held, key].join('+');
}
