// Derived from TextFold textfold/web/reader.js (snapshot, buildMotion, morph and its ghost layer) at commit 5fc941d
// (Apache-2.0). Changed for tfold: ported to TypeScript for one block at a time. A word is a range of the text that
// the block shows, never an element of its own, so the page's markup is not split and a formula stays whole. While a
// block changes, its text is hidden and every word on screen is a ghost: a word that leaves fades out where it was,
// a kept word then slides from its old place to its new one, and a new word fades in once the kept words land, so a
// moving word never crosses a fading one.

import type { Word, WordId } from '../fold/align.ts';
import { tokenize } from '../fold/local.ts';
import { overlayAttr, token } from './overlay.ts';
import { atomic, read, type Atom } from './text.ts';

export type View = { root: Element; words: readonly Word[] };

type Kind = 'move' | 'in' | 'out';
type Look = { style: number; color: string; rtl: boolean };
// A run of one word's characters on one line and in one text node, or a whole atom. `at` is the offset of its first
// character in the word, so the parts of a word tile its text however a level wraps it.
type Part = Look & { at: number; text: string; rect: DOMRect; opacity: number; atom: Node | undefined };
type Shot = Map<WordId, Part[]>;
type Slice = { part: Part; from: number; to: number };
// Characters of one word that share a part before the change and a part after it, so one ghost can carry them.
type Piece = { id: WordId; at: number; text: string; before: Slice | undefined; after: Slice | undefined };
type Ghost = { el: HTMLElement; kind: Kind; piece: Piece };
type Next = { el: Element; top: number };
type Running = { layer: HTMLElement; gap: HTMLElement | undefined; hidden: Range; animations: Animation[] };
type Route = 'rows' | 'columns' | 'straight';
type Trip = { start: DOMRect; end: DOMRect };

const layerTag = 'tfold-ghosts';
const groupTag = 'tfold-group';
const ghostTag = 'tfold-w';
const gapTag = 'tfold-gap';
const morphAttr = 'data-tfold-morph';
const wordAttr = 'data-tf-w';
const atAttr = 'data-tf-at';
const kindAttr = 'data-tf-ghost';
const styleAttr = 'data-tf-s';
const closing = 'cubic-bezier(.45,0,.2,1)';
// When some word changes rows first, a word that changes rows last starts lateMs after it, once the words it must pass
// have changed rows, and each leg of a two-leg route takes axisShare of the move. When no word that changes rows moves
// sideways, the block only shifts, so every word moves on one leg from the start.
const fadeOutMs = 110;
const moveStartMs = 70;
const moveMs = 200;
const lateMs = 80;
const axisShare = 0.55;
const fadeInMs = 100;
const fadeInEarlyMs = 50;

// `-webkit-locale` is the computed `lang`, which picks the font that a generic family such as serif resolves to and the
// font that draws the characters the named fonts lack.
const textStyle = [
	'-webkit-locale',
	'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant-ligatures', 'font-variant-caps',
	'font-variant-numeric', 'font-variant-east-asian', 'font-feature-settings', 'font-variation-settings', 'font-kerning',
	'letter-spacing', 'word-spacing', 'text-transform', 'text-decoration-line', 'text-decoration-style',
	'text-decoration-color', 'text-decoration-thickness', 'text-underline-offset', 'text-shadow', 'line-height', 'color',
	'direction',
];
const boxStyle = ['width', 'height', 'vertical-align', 'box-sizing'];
const bare = 'margin:0!important;padding:0!important;border:0!important;pointer-events:none!important;transition:none!important';
const baseRules =
	`${layerTag},${groupTag}{position:absolute!important;display:block!important;left:0!important;top:0!important;` +
	`width:0!important;height:0!important;overflow:visible!important;transform:none!important;${bare}}` +
	`${layerTag}{z-index:2147483646!important}` +
	`${ghostTag}{position:absolute!important;display:block!important;white-space:nowrap!important;max-width:none!important;` +
	`float:none!important;background:none!important;transform-origin:0 0;${bare}}` +
	'::highlight(tfold-morph){color:transparent;-webkit-text-fill-color:transparent;text-shadow:none;text-decoration-color:transparent}';

const running = new Map<string, Running>();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let sheet: { el: HTMLStyleElement; styles: Map<string, number> } | undefined;
let hiding: Highlight | undefined;

function near(rect: DOMRect): boolean {
	return rect.bottom > -innerHeight && rect.top < 2 * innerHeight && (rect.width > 0 || rect.height > 0);
}

const inView = (rect: DOMRect): boolean => rect.bottom > 0 && rect.top < innerHeight && rect.height > 0;

// A ghost inherits from the root element. Chrome reports the default font family by one font's name, while the text
// draws in the default font of its own language, so a family that the text shares with the root element is inherited.
function css(style: CSSStyleDeclaration, names: string[]): string {
	const root = getComputedStyle(document.documentElement);
	return names
		.filter((name) => name !== 'font-family' || style.getPropertyValue(name) !== root.getPropertyValue(name))
		.map((name) => `${name}:${style.getPropertyValue(name)}`)
		.join(';');
}

function styleId(declarations: string): number {
	if (!sheet?.el.isConnected) {
		const el = sheet?.el ?? Object.assign(document.createElement('style'), { className: 'tfold-morph', textContent: baseRules });
		(document.head ?? document.documentElement).append(el);
		sheet = { el, styles: new Map() };
	}
	let id = sheet.styles.get(declarations);
	if (id === undefined) {
		id = sheet.styles.size;
		sheet.styles.set(declarations, id);
		sheet.el.sheet?.insertRule(`${ghostTag}[${styleAttr}="${id}"]{${declarations}}`, sheet.el.sheet.cssRules.length);
	}
	return id;
}

const owned = `[${overlayAttr}], ${gapTag}`;

function pathTo(el: Element): string {
	let path = '';
	for (let node = el, parent = el.parentElement; parent; node = parent, parent = parent.parentElement) {
		path = `>:nth-child(${[...parent.children].filter((child) => !child.matches(owned)).indexOf(node) + 1} of :not(${owned}))${path}`;
	}
	return `:root${path}`;
}

function veilOf(root: Element): string {
	const original = root.hasAttribute(overlayAttr) ? root.previousElementSibling : null;
	return `${original ? `${pathTo(original)}+[${overlayAttr}]` : pathTo(root)} :is(${atomic}){visibility:hidden!important}`;
}

function contentRect(ghost: Element): DOMRect {
	const content = ghost.firstChild;
	if (content instanceof Element) return content.getBoundingClientRect();
	const range = document.createRange();
	range.selectNodeContents(ghost);
	return range.getBoundingClientRect();
}

function onOneLine(range: Range): boolean {
	const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
	const [first] = rects;
	return first !== undefined && rects.every((rect) => Math.abs(rect.top - first.top) < first.height / 2);
}

function lineParts(node: Text, from: number, to: number): { from: number; to: number; rect: DOMRect }[] {
	const range = document.createRange();
	const parts: { from: number; to: number; top: number; height: number }[] = [];
	for (let at = from; at < to; ) {
		const next = at + ((node.data.codePointAt(at) ?? 0) > 0xffff ? 2 : 1);
		range.setStart(node, at);
		range.setEnd(node, next);
		const { top, height } = range.getBoundingClientRect();
		const part = parts.at(-1);
		if (part && Math.abs(top - part.top) < part.height / 2) part.to = next;
		else parts.push({ from: at, to: next, top, height });
		at = next;
	}
	return parts.map((part) => {
		range.setStart(node, part.from);
		range.setEnd(node, part.to);
		return { from: part.from, to: part.to, rect: range.getBoundingClientRect() };
	});
}

function atomClone(atom: Element): Node {
	const clone = atom.cloneNode(true) as Element;
	for (const el of [clone, ...clone.querySelectorAll('[id]')]) el.removeAttribute('id');
	if (clone instanceof HTMLElement || clone instanceof SVGElement || clone instanceof MathMLElement) {
		clone.style.cssText += `;${css(getComputedStyle(atom), [...textStyle, ...boxStyle])}`;
	}
	return clone;
}

function looksOf({ root, words }: View): Shot {
	const shot: Shot = new Map();
	if (!near(root.getBoundingClientRect())) return shot;
	const { text, nodes, atoms } = read(root);
	const looks = new Map<Element, Look>();
	// A ghost's letters take its color as that animates, unless the page fills them with another color.
	const lookOf = (el: Element) => {
		let look = looks.get(el);
		if (!look) {
			const computed = getComputedStyle(el);
			const { color, webkitTextFillColor: fill } = computed;
			const declarations = css(computed, textStyle) + (fill === color ? '' : `;-webkit-text-fill-color:${fill}`);
			look = { style: styleId(declarations), color, rtl: computed.direction === 'rtl' };
			looks.set(el, look);
		}
		return look;
	};
	const atomsAfter = new Map<string, number>();
	let before = '';
	const addAtom = ({ el }: Atom) => {
		const count = atomsAfter.get(before) ?? 0;
		atomsAfter.set(before, count + 1);
		const rect = el.getBoundingClientRect();
		if (near(rect)) shot.set(`a${before}.${count}` as WordId, [{ at: 0, text: '', rect, opacity: 1, ...lookOf(el.parentElement ?? root), atom: atomClone(el) }]);
	};
	const nodeAt = (offset: number) => {
		let [lo, hi] = [0, nodes.length - 1];
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((nodes[mid]?.at ?? Infinity) <= offset) lo = mid;
			else hi = mid - 1;
		}
		return nodes[lo];
	};
	const outsideAtoms = (from: number, to: number) => {
		const pieces: [number, number][] = [];
		let at = from;
		for (const { start, end } of atoms) {
			if (start === end || end <= at || start >= to) continue;
			if (start > at) pieces.push([at, start]);
			at = Math.max(at, end);
		}
		if (at < to) pieces.push([at, to]);
		return pieces;
	};
	const range = document.createRange();
	const partsOf = (from: number, to: number, word: number): Part[] => {
		const parts: Part[] = [];
		for (let start = from; start < to; ) {
			const holder = nodeAt(start);
			const end = holder ? Math.min(to, holder.at + holder.node.data.length) : start;
			if (!holder || end <= start) break;
			range.setStart(holder.node, start - holder.at);
			range.setEnd(holder.node, end - holder.at);
			const lines = onOneLine(range)
				? [{ from: start - holder.at, to: end - holder.at, rect: range.getBoundingClientRect() }]
				: lineParts(holder.node, start - holder.at, end - holder.at);
			const look = lookOf(holder.node.parentElement ?? root);
			for (const line of lines) {
				const at = holder.at + line.from;
				parts.push({ at: at - word, text: text.slice(at, holder.at + line.to), rect: line.rect, opacity: 1, ...look, atom: undefined });
			}
			start = end;
		}
		return parts;
	};
	let atom = 0;
	for (const [k, token] of tokenize(text).entries()) {
		const word = words[k];
		if (word?.t !== token.t) return shot;
		while (atoms[atom] && (atoms[atom]?.start ?? Infinity) <= token.at) addAtom(atoms[atom++] as Atom);
		const parts = outsideAtoms(token.at, token.at + token.t.length)
			.flatMap(([from, to]) => partsOf(from, to, token.at))
			.filter((part) => near(part.rect));
		if (parts.length > 0) shot.set(word.id, parts);
		before = word.id;
	}
	while (atoms[atom]) addAtom(atoms[atom++] as Atom);
	return shot;
}

function looksOfGhosts(layer: Element): Shot {
	const shot: Shot = new Map();
	for (const ghost of layer.querySelectorAll(`[${wordAttr}]`)) {
		const id = ghost.getAttribute(wordAttr) as WordId;
		const computed = getComputedStyle(ghost);
		const seen = Number(computed.opacity) * Number(ghost.parentElement ? getComputedStyle(ghost.parentElement).opacity : 1);
		const content = ghost.firstChild;
		if (seen < 0.02 || !content) continue;
		const part: Part = {
			at: Number(ghost.getAttribute(atAttr)),
			text: content instanceof Text ? content.data : '',
			rect: contentRect(ghost),
			opacity: seen,
			style: Number(ghost.getAttribute(styleAttr)),
			color: computed.color,
			rtl: computed.direction === 'rtl',
			atom: content instanceof Text ? undefined : content.cloneNode(true),
		};
		shot.set(id, [...(shot.get(id) ?? []), part]);
	}
	return shot;
}

const span = (part: Part) => Math.max(1, part.text.length);

// Cuts a word wherever either level breaks it, across a line or a text node, so each piece sits on one line at both ends.
function cut(id: WordId, before: Part[] = [], after: Part[] = []): Piece[] {
	const edges = [...new Set([...before, ...after].flatMap((part) => [part.at, part.at + span(part)]))].sort((a, b) => a - b);
	return edges.slice(0, -1).flatMap((start, i) => {
		const end = edges[i + 1] ?? start;
		const holder = (parts: Part[]) => parts.find((part) => part.at <= start && end <= part.at + span(part));
		const [old, now] = [holder(before), holder(after)];
		const shown = now ?? old;
		if (!shown) return [];
		const slice = (part: Part | undefined) => part && { part, from: start - part.at, to: end - part.at };
		return [{ id, at: start, text: shown.text.slice(start - shown.at, end - shown.at), before: slice(old), after: slice(now) }];
	});
}

// A part's pieces sit side by side on its line, so each takes a share of the part's width in proportion to the width
// of the ghost that draws it.
function sliceRects(ghosts: Ghost[], widths: number[]): Map<Slice, DOMRect> {
	const byPart = new Map<Part, { slice: Slice; width: number }[]>();
	for (const [i, { piece }] of ghosts.entries()) {
		for (const slice of [piece.before, piece.after]) {
			if (slice) byPart.set(slice.part, [...(byPart.get(slice.part) ?? []), { slice, width: widths[i] ?? 0 }]);
		}
	}
	const rects = new Map<Slice, DOMRect>();
	for (const [part, slices] of byPart) {
		const { left, right, top, width, height } = part.rect;
		const total = slices.reduce((sum, slice) => sum + slice.width, 0);
		const scale = total > 0 ? width / total : 0;
		let x = 0;
		for (const slice of slices.toSorted((a, b) => a.slice.from - b.slice.from)) {
			const w = slice.width * scale;
			rects.set(slice.slice, slices.length === 1 ? part.rect : new DOMRect(part.rtl ? right - x - w : left + x, top, w, height));
			x += w;
		}
	}
	return rects;
}

function following(root: Element): Element | undefined {
	for (let node: Element | null = root; node && node !== document.body; node = node.parentElement) {
		for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
			if (isMorphNode(next)) continue;
			const { display, float, position } = getComputedStyle(next);
			if (display !== 'none' && float === 'none' && position !== 'absolute' && position !== 'fixed') return next;
		}
	}
	return undefined;
}

// The content after the block moves when the words change rows: a gap after the block holds that content where it
// was, then closes as the last words rise into a shorter block or opens as the first words drop into a taller one.
// Its height covers a block that shrank and a negative bottom margin one that grew. Both
// move the content by exactly their own size while the next element's top margin is not negative, however the
// margins around the gap collapse, so one measurement of the gap at rest places both ends of the animation.
function makeRoom(root: Element, next: Next): { gap: HTMLElement; frames: [Keyframe, Keyframe]; shrinks: boolean } | undefined {
	const settled = next.el.getBoundingClientRect().top;
	const shift = next.top - settled;
	if (Math.abs(shift) < 0.5 || parseFloat(getComputedStyle(next.el).marginTop) < 0) return undefined;
	const gap = document.createElement(gapTag);
	gap.setAttribute(morphAttr, token);
	gap.style.cssText = 'display:block!important;padding:0!important;border:0!important;margin:0;height:1px';
	root.after(gap);
	const idle = next.el.getBoundingClientRect().top - settled;
	const start = { height: `${1 + Math.max(0, shift - idle)}px`, marginBottom: `${Math.min(0, shift - idle)}px` };
	const end = { height: '1px', marginBottom: `${-idle}px` };
	Object.assign(gap.style, start);
	return { gap, frames: [start, end], shrinks: shift > 0 };
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function rowsOf(rects: DOMRect[]): number[] {
	const order = rects.map((rect, i) => ({ middle: rect.top + rect.height / 2, half: rect.height / 2, i })).sort((a, b) => a.middle - b.middle);
	const rows = new Array<number>(rects.length).fill(0);
	let row = -1;
	let line = -Infinity;
	for (const { middle, half, i } of order) {
		if (middle - line > half) [row, line] = [row + 1, middle];
		rows[i] = row;
	}
	return rows;
}

// A kept word that changes rows moves between rows first and then along its new row, or along its old row first and
// between rows last. Moving up, as a block shrinks, it changes rows last unless it must clear its old row for a word
// bound for an earlier row, or it is the first to reach a row that words from lower rows also reach. A word moving down
// takes the route it would take in the same morph played backwards, so a fold and its unfold are mirror images.
function routesOf(trips: Trip[]): Route[] {
	const starts = rowsOf(trips.map((trip) => trip.start));
	const ends = rowsOf(trips.map((trip) => trip.end));
	return trips.map(({ start, end }, i) => {
		if (Math.abs(start.top - end.top) <= end.height / 2) return 'straight';
		const up = end.top < start.top;
		const [from, to] = up ? [starts, ends] : [ends, starts];
		const [a, b] = [from[i] ?? 0, to[i] ?? 0];
		const clears = from.some((row, j) => row === a && (to[j] ?? 0) < b);
		const top = Math.min(...from.filter((_, j) => to[j] === b));
		const leads = top === a && from.some((row, j) => to[j] === b && row > a);
		return up === (clears || leads) ? 'rows' : 'columns';
	});
}

// A color change animates on its own, because an effect that also animates color runs on the main thread and its
// moves fall behind the other words while the page below lays out.
function movesOf(el: HTMLElement, from: Part, to: Part, { start, end }: Trip, route: Route, delay: number): Animation[] {
	const dx = start.left - end.left;
	const dy = start.top - end.top;
	const scale = start.height > 0 && end.height > 0 ? Math.min(4, Math.max(0.25, start.height / end.height)) : 1;
	const fades = from.opacity < 0.99;
	const moves: Animation[] = [];
	if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5 || Math.abs(scale - 1) >= 0.01 || fades) {
		const legs = route !== 'straight';
		const steps = legs ? 10 : 1;
		const frames: Keyframe[] = [];
		for (let k = 0; k <= steps; k++) {
			const e = k / steps;
			const first = smooth(e / axisShare);
			const second = smooth((e - 1 + axisShare) / axisShare);
			const [x, y] = !legs ? [e, e] : route === 'rows' ? [second, first] : [first, second];
			frames.push({ offset: e, transform: `translate(${dx * (1 - x)}px, ${dy * (1 - y)}px) scale(${scale + (1 - scale) * y})` });
		}
		if (fades) {
			Object.assign(frames[0] ?? {}, { opacity: from.opacity });
			Object.assign(frames.at(-1) ?? {}, { opacity: 1 });
		}
		moves.push(el.animate(frames, { delay, duration: moveMs, easing: legs ? 'linear' : 'ease-in-out', fill: 'both' }));
	}
	if (from.color !== to.color) moves.push(el.animate([{ color: from.color }, { color: to.color }], { delay, duration: moveMs, easing: 'ease-in-out', fill: 'both' }));
	return moves;
}

function ghostOf({ id, at, text, before, after }: Piece, kind: Kind): HTMLElement {
	const { part } = (after ?? before) as Slice;
	const el = document.createElement(ghostTag);
	el.setAttribute(wordAttr, id);
	el.setAttribute(atAttr, String(at));
	el.setAttribute(kindAttr, kind);
	el.setAttribute(styleAttr, String(part.style));
	if (kind === 'out' && part.opacity < 0.99) el.style.opacity = String(part.opacity);
	el.append(part.atom ? part.atom.cloneNode(true) : new Text(text));
	return el;
}

function play(key: string, root: Element, before: Shot, after: Shot, next: Next | undefined): void {
	if (before.size === 0 && after.size === 0) return;
	const room = next && makeRoom(root, next);
	const layer = document.createElement(layerTag);
	layer.setAttribute(morphAttr, token);
	const groups = { out: document.createElement(groupTag), in: document.createElement(groupTag), move: document.createElement(groupTag) };
	const veil = Object.assign(document.createElement('style'), { textContent: veilOf(root) });
	layer.append(veil, groups.out, groups.in, groups.move);
	document.documentElement.append(layer);
	const origin = layer.getBoundingClientRect();
	const ghosts = [...new Set([...after.keys(), ...before.keys()])].flatMap((id) =>
		cut(id, before.get(id), after.get(id)).map((piece): Ghost => {
			const kind: Kind = piece.before && piece.after ? 'move' : piece.after ? 'in' : 'out';
			const el = ghostOf(piece, kind);
			const { rect } = ((piece.after ?? piece.before) as Slice).part;
			el.style.left = `${rect.left - origin.left}px`;
			el.style.top = `${rect.top - origin.top}px`;
			groups[kind].append(el);
			return { el, kind, piece };
		}),
	);
	const landed = ghosts.map(({ el }) => contentRect(el));
	const rects = sliceRects(ghosts, landed.map((rect) => rect.width));
	const fading = groups.out.childElementCount > 0;
	const startMs = fading ? moveStartMs : 0;
	const animations: Animation[] = [];
	const moving: (Trip & { el: HTMLElement; from: Part; to: Part })[] = [];
	for (const [i, { el, kind, piece }] of ghosts.entries()) {
		const rest = (piece.after ?? piece.before) as Slice;
		const at = rects.get(rest) ?? rest.part.rect;
		const offset = { x: (landed[i]?.left ?? 0) - rest.part.rect.left, y: (landed[i]?.top ?? 0) - rest.part.rect.top };
		el.style.left = `${at.left - offset.x - origin.left}px`;
		el.style.top = `${at.top - offset.y - origin.top}px`;
		el.style.transformOrigin = `${offset.x}px ${offset.y}px`;
		if (kind === 'move' && piece.before) moving.push({ el, from: piece.before.part, to: rest.part, start: rects.get(piece.before) ?? piece.before.part.rect, end: at });
	}
	let lastLandingMs = 0;
	const routes = routesOf(moving);
	const sideways = moving.some(({ start, end }, i) => routes[i] !== 'straight' && Math.abs(start.left - end.left) >= 1);
	const late = sideways && routes.includes('rows') ? lateMs : 0;
	for (const [i, { el, from, to, ...trip }] of moving.entries()) {
		const route = sideways ? (routes[i] ?? 'straight') : 'straight';
		const delay = startMs + (route === 'columns' ? late : 0);
		const moves = movesOf(el, from, to, trip, route, delay);
		if (moves.length === 0) continue;
		animations.push(...moves);
		lastLandingMs = Math.max(lastLandingMs, delay + moveMs);
	}
	const hidden = document.createRange();
	hidden.selectNodeContents(root);
	if (!hiding) CSS.highlights.set('tfold-morph', (hiding = new Highlight()));
	hiding.add(hidden);
	if (fading) animations.push(groups.out.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fadeOutMs, easing: 'ease-out', fill: 'both' }));
	if (groups.in.childElementCount > 0) {
		const delay = Math.max(fading ? fadeOutMs : 0, lastLandingMs - fadeInEarlyMs);
		animations.push(groups.in.animate([{ opacity: 0 }, { opacity: 1 }], { delay, duration: fadeInMs, easing: 'ease-in-out', fill: 'both' }));
	}
	if (room) {
		// The gap animates from the first frame and holds still until the words change rows, because a layout animation
		// that came into effect in the middle of the morph drew a 27 ms frame.
		const [start, end] = room.frames;
		const duration = startMs + late + moveMs;
		const [from, to] = room.shrinks ? [duration - axisShare * moveMs, duration] : [startMs, startMs + axisShare * moveMs];
		const frames = [start, { ...start, offset: from / duration, easing: closing }, { ...end, offset: to / duration }, end];
		animations.push(room.gap.animate(frames, { duration, fill: 'both' }));
	}
	running.set(key, { layer, gap: room?.gap, hidden, animations });
	void Promise.all(animations.map((animation) => animation.finished)).then(
		() => {
			if (running.get(key)?.layer === layer) stop(key);
		},
		() => undefined,
	);
}

function stop(key: string): void {
	const morph = running.get(key);
	if (!morph) return;
	running.delete(key);
	for (const animation of morph.animations) animation.cancel();
	morph.layer.remove();
	morph.gap?.remove();
	hiding?.delete(morph.hidden);
}

export type MorphPart = { key: string; view: () => View; change: () => void };

// Blocks that change together change at one moment, in one layout, and every word travels from where it was to where it lands.
// Only the last block's gap holds what follows, because a word's ghost stays put in the page while a gap above it closes.
export function morphTogether(parts: readonly MorphPart[], around: (changeAll: () => void) => void = (changeAll) => changeAll()): void {
	const changeAll = () => {
		for (const { change } of parts) change();
	};
	if (reduced.matches) {
		for (const { key } of parts) stop(key);
		around(changeAll);
		return;
	}
	// One block moves as far as its words reach. A group moves what shows, because a word off screen is never seen to travel.
	const looks = (view: View): Shot => (parts.length > 1 && !inView(view.root.getBoundingClientRect()) ? new Map<WordId, Part[]>() : looksOf(view));
	const from = parts.map(({ view }) => view());
	const before = parts.map(({ key }, i) => {
		const current = running.get(key);
		return current ? looksOfGhosts(current.layer) : looks(from[i] as View);
	});
	const last = from.at(-1)?.root;
	const next = last && following(last);
	const nextTop = next?.getBoundingClientRect().top ?? 0;
	for (const { key } of parts) stop(key);
	around(changeAll);
	for (const [i, { key, view }] of parts.entries()) {
		const to = view();
		const holds = i === parts.length - 1 && next && following(to.root) === next;
		play(key, to.root, before[i] as Shot, looks(to), holds ? { el: next, top: nextTop } : undefined);
	}
}

export const morph = (key: string, view: () => View, change: () => void): void => morphTogether([{ key, view, change }]);

export function clearStrayMorphNodes(): void {
	const live = new Set<Element>([...running.values()].flatMap((morph) => (morph.gap ? [morph.layer, morph.gap] : [morph.layer])));
	for (const el of document.querySelectorAll(`${layerTag}[${morphAttr}="${token}"], ${gapTag}[${morphAttr}="${token}"]`)) if (!live.has(el)) el.remove();
}

export function isMorphNode(node: Node): boolean {
	const el = node instanceof Element ? node : node.parentElement;
	return el !== null && (el === sheet?.el || el.closest(`${layerTag}, ${gapTag}`) !== null);
}
