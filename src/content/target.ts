import type { BlockId } from '../fold/types.ts';
import type { ScrollModifier } from '../shortcuts.ts';
import { dialogs, editorAreas, inScope, type blockAt } from './blocks.ts';

export type Point = { x: number; y: number };

const frames = 'iframe, embed, object';
const surfaces = 'canvas, map';
const pictures = 'img, picture, video, audio, svg, figure, [role="img"]';
const media = `${frames}, ${surfaces}, ${pictures}`;
const largeMediaPx = 120;

const isEditor = (el: Element): boolean => (el instanceof HTMLElement && el.isContentEditable) || el.closest(editorAreas) !== null;

export const isEditable = (target: EventTarget | undefined | null): boolean => target instanceof Element && isEditor(target);

export const isFrame = (target: EventTarget | null): boolean => target instanceof Element && target.matches(frames);

export function focusedElement(): Element | null {
	let focused = document.activeElement;
	while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
	return focused;
}

export const dialogIsOpen = (): boolean =>
	[...document.querySelectorAll(dialogs)].some((el) => {
		const { left, right, top, bottom, width, height } = el.getBoundingClientRect();
		const onScreen = width > 0 && height > 0 && right > 0 && bottom > 0 && left < innerWidth && top < innerHeight;
		return onScreen && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
	});

function holdsLarge(el: Element, kinds: string): boolean {
	const holder = el.closest(kinds);
	return holder !== null && holder.getBoundingClientRect().height >= largeMediaPx;
}

const isLargeMedia = (el: Element): boolean => holdsLarge(el, media);

// Where a wheel belongs to what is at this point, on top or under the text laid over it: an editor, a frame that gets the wheel
// instead of this page, a canvas or a map, and under Control a picture, which is how a reader zooms in on it.
export function keepsWheel({ x, y }: Point, key: ScrollModifier): boolean {
	const large = key === 'ctrl' ? `${surfaces}, ${pictures}` : surfaces;
	return document.elementsFromPoint(x, y).some((el) => isEditor(el) || el.closest(frames) !== null || holdsLarge(el, large));
}

export function paragraphAt(under: Element, find: typeof blockAt): BlockId | undefined {
	if (!inScope(under) || isEditor(under)) return undefined;
	const block = find(under);
	return block && !isLargeMedia(under) ? block.id : undefined;
}
