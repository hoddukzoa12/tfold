import { tokenize } from '../fold/local.ts';
import type { Fold } from '../fold/types.ts';
import { atomic, isCitationMark, isUnread, read, type Reading } from './text.ts';

const originals = new WeakMap<Node, Node>();
const formControls = 'button, fieldset, input, object, output, select, textarea';

function startOf(reading: Reading, at: number, range: Range): void {
	const atom = reading.atoms.find(({ start, end }) => start <= at && at < end);
	const holder = reading.nodes.findLast(({ at: from }) => from <= at);
	if (atom) range.setStartBefore(atom.el);
	else if (holder) range.setStart(holder.node, at - holder.at);
}

function endOf(reading: Reading, at: number, range: Range): void {
	const atom = reading.atoms.find(({ start, end }) => start < at && at <= end);
	const holder = reading.nodes.findLast(({ at: from }) => from < at);
	if (atom) range.setEndAfter(atom.el);
	else if (holder) range.setEnd(holder.node, at - holder.at);
	for (const mark of reading.atoms) {
		if (mark.start >= at && isCitationMark(mark.el) && reading.text.slice(at, mark.start).trim() === '') range.setEndAfter(mark.el);
	}
}

function cloneWithin(node: Node, range: Range, whole: boolean): Node | undefined {
	if (!range.intersectsNode(node) || (!whole && node instanceof Element && isUnread(node))) return undefined;
	let copy: Node;
	if (node instanceof Text) {
		const from = node === range.startContainer ? range.startOffset : 0;
		copy = new Text(node.data.slice(from, node === range.endContainer ? range.endOffset : undefined));
	} else {
		copy = node.cloneNode(false);
		if (copy instanceof Element) {
			copy.removeAttribute('id');
			copy.removeAttribute('name');
			if (copy.matches(formControls)) copy.setAttribute('form', '');
		}
		const inAtom = whole || (node instanceof Element && node.matches(atomic));
		for (const child of node.childNodes) {
			const part = cloneWithin(child, range, inAtom);
			if (part) copy.appendChild(part);
		}
	}
	originals.set(copy, node);
	return copy;
}

export function briefNodes(el: Element, fold: Fold): Node[] {
	const reading = read(el);
	const tokens = tokenize(reading.text);
	const starts = [0];
	for (const sentence of fold.sentences) starts.push((starts.at(-1) ?? 0) + tokenize(sentence).length);
	const runs: [number, number][] = [];
	for (const index of fold.brief) {
		const run = runs.at(-1);
		if (run && run[1] === index) run[1] = index + 1;
		else runs.push([index, index + 1]);
	}
	const nodes: Node[] = [];
	for (const [from, to] of runs) {
		const first = tokens[starts[from] ?? Infinity];
		const last = tokens[(starts[to] ?? 0) - 1];
		if (!first || !last) continue;
		const range = document.createRange();
		startOf(reading, first.at, range);
		endOf(reading, last.at + last.t.length, range);
		if (nodes.length > 0) nodes.push(new Text(' '));
		for (const child of el.childNodes) {
			const part = cloneWithin(child, range, false);
			if (part) nodes.push(part);
		}
	}
	return nodes;
}

export function originalOf(copy: Node): Node | undefined {
	return originals.get(copy);
}

export function adoptOriginal(kept: Node, fresh: Node): void {
	const original = originals.get(fresh);
	if (original) originals.set(kept, original);
}

export function forwardClick(event: MouseEvent): void {
	const target = event.target;
	const elsewhere = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
	const original = target instanceof Element && !(elsewhere && target.closest('a[href]')) ? originals.get(target) : undefined;
	if (!(original instanceof Element)) return;
	event.preventDefault();
	event.stopPropagation();
	original.dispatchEvent(new MouseEvent('click', event));
}
