const headingSelector = 'h1, h2, h3, h4, h5, h6';
const outsideText = 'nav, footer, figure';
const referenceHeading =
	/^(?:references|citations|sources|bibliography|works cited|further reading|각주|참고 ?문헌|참고 ?자료|출처)$/iu;

export function headingText(heading: Element): string {
	return (heading.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export const depthOf = (heading: Element) => Number(heading.localName.slice(1));

export function pageHeadings(): Element[] {
	return [...document.querySelectorAll(headingSelector)].filter(
		(heading) => !heading.closest(outsideText) && headingText(heading) !== '' && heading.checkVisibility(),
	);
}

const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;

export function sectionOf(el: Element, headings: Element[]): number {
	let lo = 0;
	let hi = headings.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (follows(el, headings[mid] as Element)) lo = mid + 1;
		else hi = mid;
	}
	return lo - 1;
}

export function isReferenceSection(section: number, headings: Element[]): boolean {
	let depth = Infinity;
	for (let i = section; i >= 0 && depth > 1; i--) {
		const heading = headings[i] as Element;
		if (depthOf(heading) >= depth) continue;
		if (referenceHeading.test(headingText(heading))) return true;
		depth = depthOf(heading);
	}
	return false;
}

export const inReadingOrder = (a: { el: Element }, b: { el: Element }) => (follows(a.el, b.el) ? 1 : -1);
