const shift = (dy: number, scroller?: Element) => {
	if (dy !== 0) (scroller ?? window).scrollBy({ top: dy, behavior: 'instant' });
};

// For a block that changes: its top stays where it was, or comes into view if it had crossed the edge.
export function keepInPlace(rect: () => DOMRect, change: () => void, scroller?: Element): void {
	const before = rect();
	const viewTop = scroller?.getBoundingClientRect().top ?? 0;
	change();
	const after = rect();
	shift(before.bottom <= viewTop ? after.bottom - before.bottom : before.top < viewTop ? after.top - viewTop : after.top - before.top, scroller);
}

// For a block that something around it moves: it stays exactly where it was, wherever that is.
export function keepStill(rect: () => DOMRect, change: () => void, scroller?: Element): void {
	const before = rect();
	change();
	shift(rect().top - before.top, scroller);
}
