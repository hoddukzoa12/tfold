const unreadText = 'script, style, noscript, template, annotation, annotation-xml';
const lineBreaks = 'br, p, div, li, dt, dd, blockquote, h1, h2, h3, h4, h5, h6, tr, td, th';
const formulas = 'math, .mwe-math-element, .katex, mjx-container, .MathJax';
const texSources = 'math[alttext], annotation[encoding="application/x-tex"], img[alt]';
const scripts: Record<string, string> = { sup: '^', sub: '_' };
export const atomic = `${formulas}, sup, sub, img, svg, button, input, select, textarea`;

export type Atom = { el: Element; start: number; end: number };
export type Reading = { text: string; nodes: { node: Text; at: number }[]; atoms: Atom[] };

export function isCitationMark(el: Element): boolean {
	return el.localName === 'sup' && /^\[[^\]]*\]$/.test((el.textContent ?? '').trim());
}

export function isUnread(el: Element): boolean {
	return el.matches(unreadText) || getComputedStyle(el).display === 'none';
}

function texOf(formula: Element): string | undefined {
	const source = formula.matches(texSources) ? formula : formula.querySelector(texSources);
	const tex = source?.getAttribute('alttext') ?? source?.getAttribute('alt') ?? source?.textContent;
	return tex?.replace(/^\{\\(?:display|text)style\s*(.*)\}$/s, '$1').trim() || undefined;
}

export function read(root: Element): Reading {
	const reading: Reading = { text: '', nodes: [], atoms: [] };
	const visit = (parent: Node, inAtom: boolean) => {
		for (const node of parent.childNodes) {
			if (node instanceof Text) {
				reading.nodes.push({ node, at: reading.text.length });
				reading.text += node.data;
				continue;
			}
			if (!(node instanceof Element) || isUnread(node)) continue;
			const start = reading.text.length;
			if (isCitationMark(node)) {
				if (!inAtom) reading.atoms.push({ el: node, start, end: start });
				continue;
			}
			const atom = !inAtom && node.matches(atomic);
			if (node.matches(lineBreaks)) reading.text += ' ';
			const tex = atom && node.matches(formulas) ? texOf(node) : undefined;
			if (tex === undefined) {
				if (atom) reading.text += scripts[node.localName] ?? '';
				visit(node, inAtom || atom);
			} else {
				reading.text += tex;
			}
			if (atom) reading.atoms.push({ el: node, start, end: reading.text.length });
		}
	};
	visit(root, false);
	return reading;
}

export function textOf(el: Element): string {
	return read(el).text.replace(/\s+/g, ' ').trim();
}
