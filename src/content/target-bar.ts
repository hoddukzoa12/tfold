import { tipLook } from './hint.ts';

export type Mark = { els: readonly Element[]; limit?: { text: string; atTop: boolean } | undefined };
export type Reading = Mark | 'searching' | undefined;

const barWidth = 4;
const barGap = 6;
const edge = 2;
const stripHeight = 3;
const tipGap = 8;

const barStyle =
	`.bar{position:fixed;top:0;left:0;border-radius:2px;background:#c9fb2c;box-shadow:0 0 0 1px #2a2a2e;opacity:0;will-change:transform}` +
	'.bar[data-on]{opacity:1;transition:opacity .12s ease-out}' +
	`.tip{position:fixed;${tipLook}}` +
	'@media (prefers-reduced-motion:reduce){.bar[data-on]{transition:none}}' +
	'@media (forced-colors:active){.bar{background:Highlight;forced-color-adjust:none}}';
const hostStyle = 'all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important';

type Parts = { host: HTMLElement; bar: HTMLElement; tip: HTMLElement };
type Box = { left: number; right: number; top: number; bottom: number };
type Spot = { x: number; y: number; width: number; height: number };
type Clipper = { el: Element; clipsX: boolean; clipsY: boolean };

let parts: Parts | undefined;
let frame = 0;
let source: ((now: number) => Reading) | undefined;
let marked: readonly Element[] = [];
let lastLook: string | undefined;
let rtl = false;
let clippers: Clipper[] = [];

function holderOf(els: readonly Element[]): Element | null {
	let up = els[0]?.parentElement ?? null;
	while (up && !els.every((el) => up?.contains(el))) up = up.parentElement;
	return up;
}

// The page's own scrolling is the window's, which the view starts from, so the walk stops short of the body.
function clippersFrom(start: Element | null): Clipper[] {
	const found: Clipper[] = [];
	for (let up = start; up && up !== document.body; up = up.parentElement) {
		const { overflowX, overflowY } = getComputedStyle(up);
		if (overflowX !== 'visible' || overflowY !== 'visible') found.push({ el: up, clipsX: overflowX !== 'visible', clipsY: overflowY !== 'visible' });
	}
	return found;
}

function clip(view: Box, { el, clipsX, clipsY }: Clipper): Box {
	const { left, top } = el.getBoundingClientRect();
	const [inX, inY] = [left + el.clientLeft, top + el.clientTop];
	return {
		left: clipsX ? Math.max(view.left, inX) : view.left,
		right: clipsX ? Math.min(view.right, inX + el.clientWidth) : view.right,
		top: clipsY ? Math.max(view.top, inY) : view.top,
		bottom: clipsY ? Math.min(view.bottom, inY + el.clientHeight) : view.bottom,
	};
}

function union(boxes: Box[]): Box | undefined {
	if (boxes.length === 0) return undefined;
	return {
		left: Math.min(...boxes.map((box) => box.left)),
		right: Math.max(...boxes.map((box) => box.right)),
		top: Math.min(...boxes.map((box) => box.top)),
		bottom: Math.max(...boxes.map((box) => box.bottom)),
	};
}

function textBox(el: Element): DOMRect {
	const range = document.createRange();
	range.selectNodeContents(el);
	return range.getBoundingClientRect();
}

// Only what shows decides how far the words reach, which also keeps a long run from reading the text it has scrolled away from.
function wordsBox(els: readonly Element[], boxes: Box[], view: Box): Box | undefined {
	return union(els.flatMap((el, i) => ((boxes[i] as Box).bottom > view.top && (boxes[i] as Box).top < view.bottom ? [textBox(el)] : [])));
}

// Beside the text where the view leaves room, on the reader's side first. A block with no room on either side gets a
// strip along whichever edge shows, in the space between lines. With neither edge showing there is nowhere to go but
// over the words, so the bar stays off.
function spotFor(block: Box, text: Box, view: Box, startsRight: boolean): Spot | undefined {
	const y = Math.max(block.top, view.top);
	const height = Math.min(block.bottom, view.bottom) - y;
	const stripX = Math.max(block.left, view.left);
	const stripWidth = Math.min(block.right, view.right) - stripX;
	if (height <= 0 || stripWidth <= 0) return undefined;
	const before = text.left - view.left >= barWidth + edge ? { x: Math.max(text.left - barGap - barWidth, view.left + edge), y, width: barWidth, height } : undefined;
	const after = view.right - text.right >= barWidth + edge ? { x: Math.min(text.right + barGap, view.right - barWidth - edge), y, width: barWidth, height } : undefined;
	const beside = startsRight ? (after ?? before) : (before ?? after);
	if (beside) return beside;
	if (block.top - stripHeight >= view.top) return { x: stripX, y: block.top - stripHeight, width: stripWidth, height: stripHeight };
	if (block.bottom + stripHeight <= view.bottom) return { x: stripX, y: block.bottom, width: stripWidth, height: stripHeight };
	return undefined;
}

function ensureParts(): Parts {
	if (parts?.host.isConnected) return parts;
	const host = document.createElement('tf-bar');
	host.style.cssText = hostStyle;
	const root = host.attachShadow({ mode: 'open' });
	const css = document.createElement('style');
	css.textContent = barStyle;
	const bar = document.createElement('div');
	bar.className = 'bar';
	const tip = document.createElement('div');
	tip.className = 'tip';
	tip.setAttribute('role', 'status');
	tip.hidden = true;
	root.append(css, bar, tip);
	document.documentElement.append(host);
	parts = { host, bar, tip };
	return parts;
}

function showLimit(tip: HTMLElement, { text, atTop }: NonNullable<Mark['limit']>, { x, y, height }: Spot): void {
	tip.textContent = text;
	tip.hidden = false;
	const place = atTop ? y : y + height - tip.offsetHeight;
	tip.style.top = `${Math.round(Math.max(tipGap, Math.min(place, innerHeight - tip.offsetHeight - tipGap)))}px`;
	tip.style.left = `${Math.round(Math.max(tipGap, Math.min(x + barWidth + tipGap, innerWidth - tip.offsetWidth - tipGap)))}px`;
}

const clippersOf = (els: readonly Element[]): Clipper[] => clippersFrom(els.length === 1 ? (els[0]?.parentElement ?? null) : holderOf(els));

function spotOf(els: readonly Element[], clips: Clipper[], startsRight: boolean): Spot | undefined {
	const view = clips.reduce(clip, { left: 0, right: innerWidth, top: 0, bottom: innerHeight });
	const boxes = els.map((el) => el.getBoundingClientRect());
	const [block, text] = [union(boxes), wordsBox(els, boxes, view)];
	return block && text && spotFor(block, text, view, startsRight);
}

// Whether the line has anywhere to go for these. An input asks this and not whether the line is up, because a key can come before
// the frame that raises it.
export const lineFits = (els: readonly Element[]): boolean => spotOf(els, clippersOf(els), false) !== undefined;

function place({ bar, tip }: Parts, { els, limit }: Mark): void {
	if (els.length !== marked.length || els.some((el, i) => el !== marked[i])) {
		marked = els;
		rtl = els[0] !== undefined && getComputedStyle(els[0]).direction === 'rtl';
		clippers = clippersOf(els);
	}
	const spot = spotOf(els, clippers, rtl);
	const look = spot && `${spot.x} ${spot.y} ${spot.width} ${spot.height} ${limit?.text ?? ''} ${String(limit?.atTop)}`;
	if (look === lastLook) return;
	lastLook = look;
	if (!spot) {
		delete bar.dataset.on;
		tip.hidden = true;
		return;
	}
	// Rounded inward, so a stray pixel never carries the bar past the edge of the view it was clipped to.
	const top = Math.ceil(spot.y);
	bar.style.transform = `translate(${Math.round(spot.x)}px,${top}px)`;
	bar.style.width = `${Math.round(spot.width)}px`;
	bar.style.height = `${Math.floor(spot.y + spot.height) - top}px`;
	bar.dataset.on = '';
	if (limit) showLimit(tip, limit, spot);
	else tip.hidden = true;
}

function hide(): void {
	marked = [];
	lastLook = undefined;
	if (!parts) return;
	delete parts.bar.dataset.on;
	parts.tip.hidden = true;
}

function run(now: number): void {
	const reading = source?.(now);
	if (reading === undefined) {
		frame = 0;
		hide();
		return;
	}
	if (reading === 'searching') hide();
	else place(ensureParts(), reading);
	frame = requestAnimationFrame(run);
}

export function wakeBar(read: (now: number) => Reading): void {
	source = read;
	if (frame === 0) frame = requestAnimationFrame(run);
}

export function removeBar(): void {
	cancelAnimationFrame(frame);
	frame = 0;
	source = undefined;
	marked = [];
	lastLook = undefined;
	parts?.host.remove();
	parts = undefined;
}
