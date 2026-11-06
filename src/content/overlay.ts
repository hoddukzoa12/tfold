import { ladder, type Word } from '../fold/align.ts';
import type { FoldError } from '../fold/providers/index.ts';
import type { Fold, FoldedLevel } from '../fold/types.ts';
import { t, type TextKey } from '../i18n.ts';
import { adoptOriginal, briefNodes, forwardClick, originalOf } from './brief-dom.ts';
import type { Shown } from './model-fold.ts';
import { read } from './text.ts';

// Chrome keeps a copy of this script running in an open tab after tfold reloads, updates or goes away, and starts a
// fresh copy beside it. Each copy marks what it adds with its own token and places, sweeps and restores only that.
export const token = Math.random().toString(36).slice(2, 10);
export const hiddenAttr = 'data-tfold-hidden';
export const overlayAttr = 'data-tfold-overlay';
const ownOverlay = `[${overlayAttr}="${token}"]`;
// Two copies can hide one paragraph, so this attribute lists the token of each.
const ownHidden = `[${hiddenAttr}~="${token}"]`;
// A build from before tokens marked its folds with these names, and its copies keep folding after Chrome cuts them off.
const untokenedOverlay = '[data-tf-overlay]';
const anyOverlay = `[${overlayAttr}], ${untokenedOverlay}`;
const levelAttr = 'data-tf-level';
const foldAttr = 'data-tf-fold';
const badgeAttr = 'data-tf-badge';
const errorAttr = 'data-tf-error';
const pendingAttr = 'data-tf-pending';
const copiedAttrs = ['class', 'lang', 'dir', 'value'];
// What paints the letters and sizes them.
const ink = [
	'color', '-webkit-text-fill-color', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'text-shadow',
	'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant-ligatures', 'font-variant-caps',
	'font-variant-numeric', 'font-variant-east-asian', 'font-feature-settings', 'font-variation-settings', 'font-kerning',
	'line-height', 'letter-spacing', 'word-spacing', 'text-transform', 'direction',
];
const sides = ['top', 'right', 'bottom', 'left'];
// What paints the surface under the letters, and where the box sits and how wide its lines run.
const surface = [
	'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat',
	'background-origin', 'background-clip', '-webkit-background-clip', 'color-scheme', 'opacity', 'filter', 'mix-blend-mode',
	...sides.flatMap((side) => [`padding-${side}`, `border-${side}-width`, `border-${side}-style`, `border-${side}-color`]),
	...['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((corner) => `border-${corner}-radius`),
	'box-sizing', 'writing-mode', 'inline-size', 'min-inline-size', 'max-inline-size', 'float', 'text-align',
];
const transparent = /^rgba\(.*,\s*0\)$|\/\s*0\)$/;
// What a change of theme moves. These cost little next to a whole look, so a fold reads them first.
const telltales = ['color', '-webkit-text-fill-color', 'background-color', 'background-image', 'color-scheme', 'font-family', 'font-size'];
const repaints = /color|backgroundImage|^--/i;

// A page picks a text color for the background under it, so a copy takes its ink and its surface from the same place,
// read at the same moment and set in full, so no rule of the page can change one without the other. The ink may come
// from a run inside the box only when nothing between them has a background of its own.
type Look = { text: Element; box: Element };

const contentAt: Record<FoldedLevel, (el: Element, fold: Fold) => Node[]> = {
	1: briefNodes,
	2: (_, fold) => [new Text(fold.key)],
	3: (_, fold) => [new Text(fold.takeaway)],
};

const badges: Record<FoldError, TextKey | undefined> = {
	'no-key': 'badgeNoKey',
	'quick-only': undefined,
	refused: 'badgeRefused',
	'rate-limit': 'badgeRateLimit',
	network: 'badgeNetwork',
	failed: 'badgeFailed',
};

const badgeStyle =
	'content:attr(data-tf-badge);display:inline-block;margin-left:.5em;padding:0 .6em;border:1px solid rgba(255,255,255,.16);border-radius:.8em;' +
	'background:#2a2a2e;color:#fff;font:500 12px/1.7 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;letter-spacing:-.01em;' +
	'text-indent:0;vertical-align:middle;white-space:normal;word-break:keep-all;overflow-wrap:break-word';

const limeRgb = '201,251,44';
const graphiteRgb = '42,42,46';
const rail = (alpha: number) => `box-shadow:-5px 0 0 -2px rgba(${limeRgb},${alpha}),-6px 0 0 -2px rgba(${graphiteRgb},${alpha})`;
const pendingStyle =
	`${ownOverlay}[${pendingAttr}]{${rail(0.9)};animation:tfold-pending .9s ease-in-out infinite alternate}` +
	`@keyframes tfold-pending{from{${rail(0.45)}}to{${rail(1)}}}` +
	`@media (prefers-reduced-motion:reduce){${ownOverlay}[${pendingAttr}]{animation:none}}`;
// These hide the folds of a copy from before tokens and show the paragraphs it hid, so that copy shows nothing.
const untokenedStyle = `${untokenedOverlay},:root>tf-ghosts{display:none!important}[data-tf-hidden]:not([${hiddenAttr}]){display:revert!important}`;

let style: HTMLStyleElement | undefined;
const rendered = new WeakMap<Element, { fold: Fold; level: FoldedLevel }>();
const lastRead = new WeakMap<Element, { look: Look; telltale: string }>();

export function shownWords(overlay: Element): readonly Word[] | undefined {
	const shown = rendered.get(overlay);
	return shown && ladder(shown.fold)[shown.level];
}

export function ensureStyle(): void {
	if (!style) {
		style = document.createElement('style');
		style.textContent = `${ownHidden}{display:none!important}${ownOverlay}[${badgeAttr}]::after{${badgeStyle}}${pendingStyle}${untokenedStyle}`;
	}
	if (!style.isConnected) (document.head ?? document.documentElement).append(style);
}

function hasOwnBackground(el: Element): boolean {
	const { backgroundColor, backgroundImage } = getComputedStyle(el);
	return backgroundImage !== 'none' || !transparent.test(backgroundColor);
}

function liesOn(holder: Element, box: Element): boolean {
	for (let up: Element | null = holder; up && up !== box; up = up.parentElement) {
		if (up.localName === 'a' || hasOwnBackground(up)) return false;
	}
	return true;
}

function mainText(el: Element): Element {
	const letters = new Map<Element, number>();
	for (const { node } of read(el).nodes) {
		const holder = node.parentElement;
		if (holder && liesOn(holder, el)) letters.set(holder, (letters.get(holder) ?? 0) + node.data.trim().length);
	}
	let main = el;
	for (const [holder, count] of letters) if (count > (letters.get(main) ?? 0)) main = holder;
	return main;
}

// A fade is an animation of the page's style sheets, whose end a document sees, that moves a color around the element.
function fadesAround(el: Element): boolean {
	return document.getAnimations().some((animation) => {
		if (!(animation instanceof CSSTransition || animation instanceof CSSAnimation) || animation.playState !== 'running') return false;
		const { effect } = animation;
		return effect instanceof KeyframeEffect && effect.target?.contains(el) === true && effect.getKeyframes().some((frame) => Object.keys(frame).some((name) => repaints.test(name)));
	});
}

function aroundOf(box: Element): Element | null {
	return box.assignedSlot ?? box.parentElement;
}

// Text that takes its color from around it keeps taking it over the page's own background, so the letters and what is
// under them move together through a fade or a switch the DOM does not show, as the page's own text does. Over a box's
// own background, which is a reading, it does so only until the fade stops. As a value of `color`, currentcolor is the
// color from around.
function followsPage({ text, box }: Look): boolean {
	const around = aroundOf(box);
	return around !== null && getComputedStyle(text).color === getComputedStyle(around).color && (!hasOwnBackground(box) || fadesAround(box));
}

// Chrome reports the default font by one font's name, while the text draws in the default font of its own language, so
// pinning that name would change the font. A family the text shares with what its box inherits from stays inherited.
function pinnedInk({ text, box }: Look): string[] {
	const around = aroundOf(box);
	const inherited = around !== null && getComputedStyle(text).fontFamily === getComputedStyle(around).fontFamily;
	return inherited ? ink.filter((name) => name !== 'font-family') : ink;
}

function snapshot(look: Look): string {
	const color = getComputedStyle(look.text).color;
	const follows = followsPage(look);
	const declare = (names: string[], source: Element) => {
		const style = getComputedStyle(source);
		return names.map((name) => {
			const value = style.getPropertyValue(name);
			return `${name}:${follows && value === color ? 'currentcolor' : value}!important`;
		});
	};
	return [...declare(pinnedInk(look), look.text), ...declare(surface, look.box)].join(';');
}

function telltaleOf(overlay: Element, look: Look): string {
	const originals = [...overlay.querySelectorAll('*')].map(originalOf).filter((original) => original instanceof Element);
	const values = [...new Set([look.text, look.box, ...originals])].flatMap((el) => {
		const style = getComputedStyle(el);
		return telltales.map((name) => style.getPropertyValue(name));
	});
	return [followsPage(look), fadesAround(look.box), ...values].join();
}

// False when the values a theme moves are as they were at the fold's last reading, so its look needs no new reading.
export function lookMoved(overlay: Element): boolean {
	const read = lastRead.get(overlay);
	return read === undefined || telltaleOf(overlay, read.look) !== read.telltale;
}

function dress(nodes: Node[]): Node[] {
	for (const node of nodes) {
		for (const copy of node instanceof Element ? [node, ...node.querySelectorAll('*')] : []) {
			const original = originalOf(copy);
			if (!(original instanceof Element)) continue;
			const own = copy.getAttribute('style');
			copy.setAttribute('style', `${own ? `${own};` : ''}${snapshot({ text: original, box: original })}`);
		}
	}
	return nodes;
}

function create(el: Element): HTMLElement {
	const overlay = document.createElement(el.localName);
	for (const name of copiedAttrs) {
		const value = el.getAttribute(name);
		if (value !== null) overlay.setAttribute(name, value);
	}
	overlay.setAttribute(overlayAttr, token);
	overlay.addEventListener('click', forwardClick, true);
	return overlay;
}

function setAttr(el: Element, name: string, value: string | undefined): void {
	if (value === undefined) el.removeAttribute(name);
	else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function syncAttributes(el: Element, like: Element): void {
	for (const { name } of [...el.attributes]) if (!like.hasAttribute(name)) el.removeAttribute(name);
	for (const { name, value } of like.attributes) setAttr(el, name, value);
}

function patch(parent: Element, fresh: readonly Node[]): void {
	const shown = [...parent.childNodes];
	if (shown.length !== fresh.length) {
		parent.replaceChildren(...fresh);
		return;
	}
	for (const [i, node] of fresh.entries()) {
		const old = shown[i] as ChildNode;
		if (old.nodeName !== node.nodeName) {
			old.replaceWith(node);
			continue;
		}
		if (old instanceof CharacterData && node instanceof CharacterData) {
			if (old.data !== node.data) old.data = node.data;
		} else if (old instanceof Element && node instanceof Element) {
			syncAttributes(old, node);
			patch(old, [...node.childNodes]);
		}
		adoptOriginal(old, node);
	}
}

function isOtherOverlay(node: Node | null): node is Element {
	return node instanceof Element && node.matches(anyOverlay) && !node.matches(ownOverlay);
}

// Another copy may keep its own fold of this paragraph right after it. This overlay is in place when only folds of
// other copies stand between, so neither copy moves the other's fold.
function followsItsBlock(el: Element, overlay: Element): boolean {
	let next = el.nextSibling;
	while (next !== overlay && isOtherOverlay(next)) next = next.nextSibling;
	return next === overlay;
}

export function isInPlace(el: Element, overlay: Element | null): boolean {
	return overlay !== null && el.matches(ownHidden) && followsItsBlock(el, overlay);
}

export function show(el: Element, overlay: HTMLElement | null, level: FoldedLevel, shown: Shown): HTMLElement {
	ensureStyle();
	const content = contentAt[level](el, shown.fold);
	const status = shown.from === 'local' ? shown.status : undefined;
	const error = status?.state === 'failed' ? status.error : undefined;
	const badgeKey = error && badges[error];
	const badge = badgeKey && t(badgeKey);
	const target = overlay ?? create(el);
	rendered.set(target, { fold: shown.fold, level });
	setAttr(target, levelAttr, String(level));
	setAttr(target, 'lang', level !== 1 && shown.fold.writtenIn ? shown.fold.writtenIn : (el.getAttribute('lang') ?? undefined));
	setAttr(target, foldAttr, shown.from);
	setAttr(target, pendingAttr, status?.state === 'pending' ? '' : undefined);
	setAttr(target, 'aria-busy', status?.state === 'pending' ? 'true' : undefined);
	setAttr(target, errorAttr, error);
	setAttr(target, badgeAttr, badge);
	if (!followsItsBlock(el, target)) el.after(target);
	// Everything that can fail has run, so a broken fold leaves the paragraph on screen. A hidden paragraph reads its
	// sizes as the page wrote them, not as this window's pixels, so the look is read from here on, and every reading
	// agrees with the last one.
	if (!el.matches(ownHidden)) el.setAttribute(hiddenAttr, `${el.getAttribute(hiddenAttr) ?? ''} ${token}`.trim());
	const look = { text: level === 1 ? el : mainText(el), box: el };
	setAttr(target, 'style', snapshot(look));
	patch(target, dress(content));
	lastRead.set(target, { look, telltale: telltaleOf(target, look) });
	return target;
}

export function relabelBadges(): void {
	for (const overlay of document.querySelectorAll(`${ownOverlay}[${errorAttr}]`)) {
		const error = overlay.getAttribute(errorAttr) ?? '';
		const badge = Object.hasOwn(badges, error) ? badges[error as FoldError] : undefined;
		if (badge) overlay.setAttribute(badgeAttr, t(badge));
	}
}

function unhide(el: Element): void {
	if (!el.matches(ownHidden)) return;
	const others = (el.getAttribute(hiddenAttr) ?? '').split(' ').filter((owner) => owner !== '' && owner !== token);
	if (others.length > 0) el.setAttribute(hiddenAttr, others.join(' '));
	else el.removeAttribute(hiddenAttr);
}

export function clearStrays(tracked: ReadonlySet<Element>): void {
	for (const el of document.querySelectorAll(`${ownHidden}, ${ownOverlay}`)) {
		if (tracked.has(el)) continue;
		if (el.matches(ownOverlay)) el.remove();
		else unhide(el);
	}
}

export function restore(el: Element, overlay: HTMLElement | null): null {
	overlay?.remove();
	unhide(el);
	return null;
}
