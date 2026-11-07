import { sourceWords } from '../fold/align.ts';
import { countWords, isShortLine, localFold, tokenize } from '../fold/local.ts';
import type { Block, BlockId, FoldedLevel, Level } from '../fold/types.ts';
import { connected } from './connection.ts';
import { foldFor, noteFolded, requestFolds, stopAskingAhead } from './model-fold.ts';
import { clearStrayMorphNodes, isMorphNode, morph, morphTogether, type View } from './morph.ts';
import { clearStrays, ensureStyle, hiddenAttr, isInPlace, lookMoved, overlayAttr, restore, show, shownWords } from './overlay.ts';
import { keepInPlace, keepStill } from './scroll.ts';
import { isReferenceSection, pageHeadings, sectionOf } from './sections.ts';
import { textOf } from './text.ts';

type Kind = { selector: string; minWords: number; accepts: (el: Element) => boolean; reads: (text: string, el: Element) => boolean };
type PageEvent = [target: EventTarget, type: string, listener: EventListener, capture: boolean];

const articleParagraphs = 'article p, main p';
const inlineContent = new Set([
	'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'img', 'ins', 'kbd', 'mark',
	'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
]);
export const editorAreas = [
	'input, textarea, select',
	'[role="textbox"], [role="searchbox"], [role="combobox"], [role="application"], [role="code"]',
	'.CodeMirror, .cm-editor, .ace_editor, .monaco-editor',
].join(', ');
const excludedAncestors = [
	'figure, nav, footer, .references, .reflist, .mw-references-wrap, .refbegin',
	'button, menu, [aria-hidden="true"]',
	editorAreas,
	'[role="button"], [role="navigation"], [role="menu"], [role="menubar"], [role="toolbar"]',
	`[${overlayAttr}]`,
].join(', ');
const notProse: Record<string, { elements: string[]; roles: string[] }> = {
	widget: {
		elements: ['a', 'label', 'legend', 'option', 'summary'],
		roles: [
			'button', 'checkbox', 'combobox', 'grid', 'gridcell', 'link', 'listbox', 'menu', 'menubar', 'menuitem',
			'menuitemcheckbox', 'menuitemradio', 'option', 'progressbar', 'radio', 'radiogroup', 'scrollbar', 'searchbox',
			'slider', 'spinbutton', 'switch', 'tab', 'tablist', 'textbox', 'tree', 'treegrid', 'treeitem',
		],
	},
	overlay: { elements: ['dialog'], roles: ['alert', 'alertdialog', 'dialog', 'marquee', 'status', 'timer', 'tooltip'] },
	landmark: { elements: ['aside', 'form', 'header'], roles: ['banner', 'complementary', 'contentinfo', 'form', 'navigation', 'search'] },
	table: { elements: ['table'], roles: ['cell', 'columnheader', 'row', 'rowgroup', 'rowheader', 'table'] },
};
const textDivAncestors = Object.values(notProse)
	.flatMap(({ elements, roles }) => [...elements, ...roles.map((role) => `[role="${role}"]`)])
	.join(', ');
const references = 'a, [role="link"], time';
const outermostReferences = `:is(${references}):not(:is(${references}) *)`;
const maxReferenceShare = 0.3;
const minSentences = 2;
const minLongWords = 25;
const runsOn = /\p{L}\.\p{L}\.["'”’)\]]*$/u;
const scrolls = new Set(['auto', 'scroll', 'overlay']);
const minShellShare = 1 / 2;
const minWords = 12;
// A paragraph, list item, quote or definition counts from here, so a short line inside a run or a translated page folds with the rest.
const minParagraphWords = 2;
const minColumnShare = 0.6;
const sameParagraphShare = 3 / 4;
export const dialogs = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const layerPositions = new Set(['fixed', 'sticky']);
const offFlowPositions = new Set(['absolute', 'fixed', 'sticky']);
const mediaElements = 'img, picture, video, canvas, svg, iframe, object, embed';
const formulas = 'math, .katex, mjx-container';
const hitShares = [1 / 4, 1 / 2, 3 / 4];
const sheetTags = 'style, link';
// A page that writes around a fold on every frame keeps the fold waiting this long at most.
const maxWaitMs = 250;

const blocks = new Map<BlockId, Block>();
const parked = new Map<BlockId, { level: FoldedLevel; content: string }>();
const observer = new MutationObserver(reconcile);
const restyler = new MutationObserver(restyle);
const pageEvents: PageEvent[] = [
	...['(prefers-color-scheme: dark)', '(forced-colors: active)'].map((query): PageEvent => [matchMedia(query), 'change', checkEvery, false]),
	[window, 'resize', checkEvery, false],
	[document, 'load', sheetLoaded, true],
	...['transitionend', 'transitioncancel', 'animationend', 'animationcancel'].map((stop): PageEvent => [document, stop, settle, true]),
];
// What folds owe the page at the next refresh. A block whose own content or attributes changed is drawn again. A fold
// whose surroundings changed first reads the few values a theme moves.
const toDraw = new Set<Block>();
const toCheck = new Set<Block>();
let refreshing = 0;
let fresh = false;
let hot = false;
let refreshedAt = -Infinity;
let onlyIn: Element | undefined;
let levelChanged: (level: Level) => void = () => {};
let lastRunAnchor: BlockId | undefined;
const scope = () => onlyIn ?? document.documentElement;

// Settings folds its one sample paragraph, never its own hints and lists, and shows the level beside it. Watching only
// that root keeps the rest of the page's changes from waking a fold.
export function foldOnlyIn(root: Element, onLevel: (level: Level) => void): void {
	onlyIn = root;
	levelChanged = onLevel;
}

function holdsOnlyInline(el: Element): boolean {
	for (let child = el.firstElementChild; child; child = child.nextElementSibling) if (!inlineContent.has(child.localName)) return false;
	return true;
}

function unspaced(text: string): string {
	return text.replace(/\s+/g, '');
}

function letters(text: string): number {
	return unspaced(text).length;
}

function mostlyReferences(el: Element, text: string): boolean {
	let referenced = 0;
	for (const reference of el.querySelectorAll(outermostReferences)) referenced += letters(reference.textContent ?? '');
	return referenced > maxReferenceShare * letters(text);
}

function holdsProse(el: Element): boolean {
	if (!holdsOnlyInline(el)) return false;
	const text = el.textContent ?? '';
	if (text.length < minWords || countWords(text, minWords) < minWords || el.closest(textDivAncestors) || mostlyReferences(el, text)) return false;
	const words = text.split(/\s+/).filter(Boolean);
	return 2 * words.filter((word) => /^[#@]./u.test(word)).length <= words.length;
}

function sentenceCount(text: string): number {
	const { sentences } = localFold(text);
	let count = 0;
	let words = 0;
	for (const [i, sentence] of sentences.entries()) {
		words += countWords(sentence);
		if (words < 2 || (i < sentences.length - 1 && runsOn.test(sentence))) continue;
		count++;
		words = 0;
	}
	return count;
}

function fillsWindow(box: Element): boolean {
	const { width, height } = box.getBoundingClientRect();
	return Math.min(width, innerWidth) * Math.min(height, innerHeight) >= minShellShare * innerWidth * innerHeight;
}

// A fixed box that fills the window and scrolls its text in a pane inside it is an app shell, the page itself. One
// that scrolls its own box, or fills less of the window, is a banner or popup laid over the page.
function pinned(el: Element): boolean {
	let inPane = false;
	for (let box: Element | null = el; box; box = box.parentElement) {
		const { position, overflowY } = getComputedStyle(box);
		if (position === 'fixed' || position === 'sticky') return !(inPane && fillsWindow(box));
		if (scrolls.has(overflowY)) inPane = true;
	}
	return false;
}

function readsAsProse(text: string, el: Element): boolean {
	return (countWords(text, minLongWords) >= minLongWords || sentenceCount(text) >= minSentences) && !pinned(el);
}

const beside = (el: Element | null) => el !== null && (el.matches(mediaElements) || el.querySelector(mediaElements) !== null);

function offFlow(el: Element): boolean {
	for (let box: Element | null = el; box; box = box.parentElement) if (offFlowPositions.has(getComputedStyle(box).position)) return true;
	return false;
}

// Text on a video, a map or a chart, a caption and a table cell are short too, and Ctrl and the wheel must stay with the
// browser over them. A short line counts only where it reads as part of the text: in the flow, away from media, and as
// wide as a long paragraph in its column. A page with no long paragraph has no text for it to be part of.
function flowsWithProse(el: Element, long: readonly DOMRect[]): boolean {
	if (el.querySelector(formulas) || beside(el.previousElementSibling) || beside(el.nextElementSibling) || offFlow(el)) return false;
	const { left, right } = el.getBoundingClientRect();
	return long.some((box) => Math.min(right, box.right) - Math.max(left, box.left) >= minColumnShare * box.width);
}

const always = () => true;

function kindsByPriority(): Kind[] {
	const paragraphsInArticle = scope().querySelector(articleParagraphs) !== null;
	const paragraphs = `${paragraphsInArticle ? articleParagraphs : 'p'}, li, blockquote, dd`;
	return [
		{ selector: '[data-testid="tweetText"]', minWords, accepts: always, reads: always },
		{ selector: paragraphs, minWords: minParagraphWords, accepts: (el) => !el.querySelector(paragraphs), reads: (text, el) => !isShortLine(text) || !mostlyReferences(el, text) },
		...(paragraphsInArticle ? [] : [{ selector: 'div, section', minWords, accepts: holdsProse, reads: readsAsProse }]),
	];
}

function hashText(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
	return (hash >>> 0).toString(36);
}

function blockId(hash: string, occurrence: number): BlockId {
	return (occurrence === 0 ? hash : `${hash}.${occurrence}`) as BlockId;
}

function isSameParagraph(before: string, after: string): boolean {
	const left = new Map<string, number>();
	const old = tokenize(before);
	for (const { t } of old) left.set(t, (left.get(t) ?? 0) + 1);
	const now = tokenize(after);
	let kept = 0;
	for (const { t } of now) {
		const count = left.get(t) ?? 0;
		if (count > 0) {
			kept++;
			left.set(t, count - 1);
		}
	}
	return kept >= sameParagraphShare * Math.max(old.length, now.length);
}

function holdsParagraph(block: Block): boolean {
	if (!block.el.isConnected) return false;
	const content = block.el.textContent ?? '';
	if (content === block.content) return true;
	if (!isSameParagraph(block.content, content)) return false;
	block.content = content;
	return true;
}

function render(block: Block): void {
	block.overlay =
		block.level !== 0 && block.el.isConnected
			? show(block.el, block.overlay, block.level, foldFor(block.id, textOf(block.el)))
			: restore(block.el, block.overlay);
}

function unbind(block: Block): void {
	blocks.delete(block.id);
	toDraw.delete(block);
	toCheck.delete(block);
	if (block.level !== 0) parked.set(block.id, { level: block.level, content: block.content });
	block.overlay = restore(block.el, block.overlay);
}

function viewOf(block: Block): View {
	const root = block.overlay ?? block.el;
	return { root, words: shownWords(root) ?? sourceWords(textOf(block.el)) };
}

function renderInPlace(block: Block, change = () => {}): void {
	morph(
		block.id,
		() => viewOf(block),
		() => {
			change();
			keepInPlace(
				() => (block.overlay ?? block.el).getBoundingClientRect(),
				() => render(block),
			);
		},
	);
}

const shownBox = (block: Block): DOMRect => (block.overlay ?? block.el).getBoundingClientRect();

function scrollerOf(el: Element, known: Map<Element, Element | undefined> = new Map()): Element | undefined {
	const up = el.parentElement;
	if (!up || up === document.body || up === document.documentElement) return undefined;
	if (known.has(up)) return known.get(up);
	const scroller = scrolls.has(getComputedStyle(up).overflowY) && up.scrollHeight > up.clientHeight ? up : scrollerOf(up, known);
	known.set(up, scroller);
	return scroller;
}

const holdStill = (steady: Block, change: () => void) => keepStill(() => shownBox(steady), change, scrollerOf(steady.el));

function changeTogether(group: Block[], change: (block: Block) => void, around: (changeAll: () => void) => void): void {
	morphTogether(
		group.map((block) => ({ key: block.id, view: () => viewOf(block), change: () => change(block) })),
		around,
	);
}

const onScreen = (block: Block): boolean => {
	const { top, bottom } = shownBox(block);
	return bottom > 0 && top < innerHeight;
};

function steadyFor(group: Block[]): Block {
	const anchor = lastRunAnchor && blocks.get(lastRunAnchor);
	if (anchor && onScreen(anchor)) return anchor;
	return group.find(onScreen) ?? group.findLast((block) => shownBox(block).bottom <= 0) ?? (group[0] as Block);
}

function swapIn(ids: BlockId[]): void {
	const group = ids.flatMap((id) => {
		const block = blocks.get(id);
		return block && block.level !== 0 ? [block] : [];
	});
	if (group.length === 0) return;
	if (lastRunAnchor === undefined) {
		for (const block of group) renderInPlace(block);
		return;
	}
	const inOrder = group.sort((a, b) => shownBox(a).top - shownBox(b).top);
	const steady = steadyFor(inOrder);
	const answered = inOrder.filter((block) => foldFor(block.id, textOf(block.el)).from === 'model');
	// A failure only changes a badge, and redrawing a whole run's words for that would drop frames in the fold it follows.
	const badged = inOrder.filter((block) => !answered.includes(block));
	holdStill(steady, () => badged.forEach(render));
	if (answered.length > 0) changeTogether(answered, render, (changeAll) => holdStill(steady, changeAll));
}

const isVisible = (el: Element): boolean => el.checkVisibility({ checkVisibilityCSS: true });

function blockText(el: Element, atLeast: number): string | undefined {
	if (!isVisible(el)) return undefined;
	const text = textOf(el);
	return countWords(text, atLeast) < atLeast ? undefined : text;
}

function detect(bound: Iterable<Element>): [Element, string][] {
	let headings: Element[] | undefined;
	const inReferences = (el: Element) => {
		headings ??= pageHeadings();
		return isReferenceSection(sectionOf(el, headings), headings);
	};
	const chosen = new Set<Element>();
	const holders = new Set<Element>();
	const choose = (el: Element) => {
		chosen.add(el);
		for (let up = el.parentElement; up && !holders.has(up); up = up.parentElement) holders.add(up);
	};
	const insideChosen = (el: Element) => {
		for (let up = el.parentElement; up; up = up.parentElement) if (chosen.has(up)) return true;
		return false;
	};
	for (const el of bound) choose(el);
	const found: [Element, string][] = [];
	const short: [Element, string][] = [];
	for (const kind of kindsByPriority()) {
		for (const el of scope().querySelectorAll(kind.selector)) {
			if (chosen.has(el) || holders.has(el) || !kind.accepts(el) || (el.textContent?.length ?? 0) < kind.minWords) continue;
			if (insideChosen(el) || el.closest(excludedAncestors) || (el instanceof HTMLElement && el.isContentEditable) || inReferences(el)) continue;
			const text = blockText(el, kind.minWords);
			if (text === undefined || !kind.reads(text, el)) continue;
			if (isShortLine(text)) {
				short.push([el, text]);
				continue;
			}
			choose(el);
			found.push([el, text]);
		}
	}
	if (short.length === 0) return found;
	const long = [...bound, ...found.map(([el]) => el)].filter((el) => !isShortLine(textOf(el))).map((el) => el.getBoundingClientRect());
	for (const [el, text] of short) {
		if (holders.has(el) || insideChosen(el) || !flowsWithProse(el, long)) continue;
		choose(el);
		found.push([el, text]);
	}
	return found.sort(([a], [b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

export function scan(): void {
	for (const block of [...blocks.values()]) if (!holdsParagraph(block)) unbind(block);
	const bound = new Set<Element>();
	for (const block of blocks.values()) {
		bound.add(block.el);
		if (block.overlay) bound.add(block.overlay);
	}
	clearStrays(bound);
	clearStrayMorphNodes();
	for (const [el, text] of detect(bound)) {
		const hash = hashText(text);
		let occurrence = 0;
		while (blocks.has(blockId(hash, occurrence))) occurrence++;
		const id = blockId(hash, occurrence);
		const block: Block = { id, el, content: el.textContent ?? '', overlay: null, level: parked.get(id)?.level ?? 0 };
		parked.delete(id);
		blocks.set(id, block);
		if (block.level !== 0) render(block);
	}
}

function folded(): Block[] {
	return [...blocks.values()].filter((block) => block.level !== 0);
}

function mayHoldParked(records: MutationRecord[]): boolean {
	const texts = records.flatMap((record) =>
		record.type === 'characterData' ? [record.target.textContent ?? ''] : [...record.addedNodes].map((node) => node.textContent ?? ''),
	);
	const contents = [...parked.values()].map((fold) => unspaced(fold.content));
	return texts.map(unspaced).some((text) => text !== '' && contents.some((content) => content.includes(text) || text.includes(content)));
}

function foldsBelow(): Map<Node, Block[]> {
	const below = new Map<Node, Block[]>();
	for (const block of folded()) {
		for (let up: Node | null = block.el; up; up = up.parentNode) {
			const held = below.get(up);
			if (held) held.push(block);
			else below.set(up, [block]);
		}
	}
	return below;
}

function holderOf(node: Node, below: Map<Node, Block[]>): Block | undefined {
	for (let up: Node | null = node; up; up = up.parentNode) {
		const [fold] = below.get(up) ?? [];
		if (fold) return fold.el === up ? fold : undefined;
	}
	return undefined;
}

function owe(folds: Set<Block>, owing: readonly Block[]): void {
	if (owing.length === 0) return;
	for (const block of owing) folds.add(block);
	fresh = true;
	refreshing ||= requestAnimationFrame(refresh);
}

// At most one refresh a frame, and none while changes keep landing frame after frame. A first change lands before the
// frame that shows it, and a stream of them lands in the first frame after it stops, or at the longest wait.
function refresh(now: number): void {
	refreshing = 0;
	if (!connected()) return;
	const streaming = fresh && hot && now - refreshedAt < maxWaitMs;
	hot = fresh;
	fresh = false;
	if (hot) refreshing = requestAnimationFrame(refresh);
	if (streaming || toDraw.size + toCheck.size === 0) return;
	refreshedAt = now;
	const due = folded().filter((block) => toDraw.has(block) || (toCheck.has(block) && block.overlay !== null && lookMoved(block.overlay)));
	toDraw.clear();
	toCheck.clear();
	for (const block of due) render(block);
}

function holdsSheet(node: Node): boolean {
	return node instanceof Element && (node.matches(sheetTags) || node.querySelector(sheetTags) !== null);
}

// Text and children that change beside a block cannot change its look, so only what changes inside it draws it again.
// A fold that a change leaves out of place is put back, and one moved under another element may look different there.
function reconcile(all: MutationRecord[]): void {
	if (!connected()) return;
	const records = all.filter((record) => {
		const nodes = [...record.addedNodes, ...record.removedNodes];
		return !isMorphNode(record.target) && !(nodes.length > 0 && nodes.every(isMorphNode));
	});
	if (records.length === 0) return;
	const stale = [...blocks.values()].filter((block) => !holdsParagraph(block));
	for (const block of stale) unbind(block);
	const reused = stale.some((block) => block.el.isConnected);
	if (parked.size > 0 && (reused || mayHoldParked(records))) scan();
	ensureStyle();
	const below = foldsBelow();
	for (const record of records) {
		if (record.type === 'attributes') continue;
		if ([...record.removedNodes].some(holdsSheet)) owe(toCheck, folded());
		const holder = holderOf(record.target, below);
		if (holder) owe(toDraw, [holder]);
		for (const node of record.addedNodes) owe(toCheck, below.get(node) ?? []);
	}
	owe(toDraw, folded().filter((block) => !isInPlace(block.el, block.overlay)));
}

function isFoldNode(node: Node): boolean {
	return isMorphNode(node) || (node instanceof Element && node.closest(`[${overlayAttr}]`) !== null);
}

// A fold holds a reading of its block's look, and an attribute can change that look when it sits on the block, inside
// it or around it, or on a style sheet's element. What any copy of this script writes is no such change, or a fold's
// own writes would wake this again.
function restyle(records: MutationRecord[]): void {
	if (!connected()) return;
	const below = foldsBelow();
	for (const { target, attributeName } of records) {
		if (attributeName === hiddenAttr) continue;
		const around = below.get(target);
		if (target instanceof HTMLStyleElement || target instanceof HTMLLinkElement) {
			if (!isFoldNode(target)) owe(toCheck, folded());
		} else if (around && around[0]?.el !== target) {
			owe(toCheck, around);
		} else {
			const holder = holderOf(target, below);
			if (holder && !isFoldNode(target)) owe(toDraw, [holder]);
		}
	}
}

function checkEvery(): void {
	owe(toCheck, folded());
}

// A style sheet that goes in, or whose text changes, fires load once it applies, which is the moment a look can move.
function sheetLoaded({ target }: Event): void {
	if (target instanceof Element && target.matches(sheetTags) && !isFoldNode(target)) checkEvery();
}

// A reading taken while an element around a block fades holds a color on its way to another one, so a fold checks its
// look again when that fade stops. A check that finds nothing new reads and writes nothing more.
function settle({ target }: Event): void {
	if (target instanceof Node) owe(toCheck, folded().filter((block) => target.contains(block.el)));
}

function watch(): void {
	const on = folded().length > 0 || parked.size > 0;
	if (on) {
		observer.observe(scope(), {
			childList: true,
			subtree: true,
			characterData: true,
			attributeFilter: [hiddenAttr],
		});
		restyler.observe(scope(), { attributes: true, subtree: true });
	} else {
		observer.disconnect();
		restyler.disconnect();
		toDraw.clear();
		toCheck.clear();
	}
	for (const [target, type, listener, capture] of pageEvents) {
		if (on) target.addEventListener(type, listener, capture);
		else target.removeEventListener(type, listener, capture);
	}
}

function find(node: Node): Block | undefined {
	for (const block of blocks.values()) if (block.el.contains(node) || block.overlay?.contains(node)) return block;
	return undefined;
}

export function heldBlock(node: Node): Readonly<Block> | undefined {
	const block = find(node);
	return block && holdsParagraph(block) ? block : undefined;
}

export function blockAt(node: Node): Readonly<Block> | undefined {
	const held = heldBlock(node);
	if (held) return held;
	scan();
	return find(node);
}

export const inScope = (node: Node): boolean => scope().contains(node);

export function levelOf(id: BlockId): Level | undefined {
	return blocks.get(id)?.level;
}

export function shownOf(id: BlockId): Element | undefined {
	const block = blocks.get(id);
	return block && (block.overlay ?? block.el);
}

// The nearest dialog, or box fixed to the window or stuck to its scroller, around this element: what it sits in over the page.
function layerOf(el: Element, known: Map<Element, Element | undefined>): Element | undefined {
	if (known.has(el)) return known.get(el);
	const root = el.getRootNode();
	const up = el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
	const layer = el.matches(dialogs) || layerPositions.has(getComputedStyle(el).position) ? el : up ? layerOf(up, known) : undefined;
	known.set(el, layer);
	return layer;
}

type Area = { left: number; right: number; top: number; bottom: number };

const windowArea = (): Area => ({ left: 0, right: innerWidth, top: 0, bottom: innerHeight });

function within({ left, right, top, bottom }: Area, of: Area): Area {
	return { left: Math.max(left, of.left), right: Math.min(right, of.right), top: Math.max(top, of.top), bottom: Math.min(bottom, of.bottom) };
}

function hitIn(shown: Element, { left, right, top, bottom }: Area, topAt = (x: number, y: number) => document.elementFromPoint(x, y)): boolean {
	return hitShares.some((share) => shown.contains(topAt((left + right) / 2, top + (bottom - top) * share)));
}

// A hit test on the document stops at a custom element, and a bar can be fixed inside one.
function innermostAt(el: Element, x: number, y: number): Element {
	const inner = el.shadowRoot?.elementFromPoint(x, y);
	return inner && el.shadowRoot?.contains(inner) ? innermostAt(inner, x, y) : el;
}

// What shows of a paragraph is on top where it sits, unless something covers it. Out of sight nothing can tell, so it counts, and
// a bar that stays put while the paragraph scrolls under it only puts it out of sight, as the edge of the window does. What moves
// with the paragraph covers it wherever the page is, and a dialog keeps what it hides out of a run.
function onTop(shown: Element, layer: Element | undefined, scroller: Element | undefined, layers: Map<Element, Element | undefined>): boolean {
	const seen = within(within(shown.getBoundingClientRect(), windowArea()), scroller?.getBoundingClientRect() ?? windowArea());
	const staysPut = (el: Element, x: number, y: number) => {
		const over = layerOf(innermostAt(el, x, y), layers);
		return !over?.matches(dialogs) && (over !== layer || (scroller !== undefined && !scroller.contains(el)));
	};
	return seen.right <= seen.left || seen.bottom <= seen.top || hitIn(shown, seen, (x, y) => document.elementsFromPoint(x, y).find((el) => !staysPut(el, x, y)) ?? null);
}

// The blocks that scroll with this one, share its column on the page, sit in the same layer and show where they are, top to
// bottom. A place on the page is the order a reader sweeps in, and a feed that reuses its cells keeps them in any order in the
// document. A run never reaches past a modal into what it hides, or from the page into a banner laid over it.
export function columnOf(id: BlockId): BlockId[] {
	const anchor = blocks.get(id);
	if (!anchor) return [];
	const scrollers = new Map<Element, Element | undefined>();
	const layers = new Map<Element, Element | undefined>();
	const scroller = scrollerOf(anchor.el, scrollers);
	const layer = layerOf(anchor.el, layers);
	const { left, right, width } = shownBox(anchor);
	const inColumn = [...blocks.values()].flatMap((block) => {
		if (!block.el.isConnected) return [];
		const shown = block.overlay ?? block.el;
		const box = shown.getBoundingClientRect();
		const shared = Math.min(box.right, right) - Math.max(box.left, left);
		if (box.height <= 0 || shared < minColumnShare * Math.min(box.width, width) || scrollerOf(block.el, scrollers) !== scroller) return [];
		if (layerOf(block.el, layers) !== layer || !isVisible(shown) || (block !== anchor && !onTop(shown, layer, scroller, layers))) return [];
		return [{ id: block.id, top: box.top }];
	});
	return inColumn.sort((a, b) => a.top - b.top).map((block) => block.id);
}

// A paragraph covered through what shows of it, by a banner or a modal, cannot be what the reader means.
export function canBeHit(id: BlockId): boolean {
	const shown = shownOf(id);
	return shown !== undefined && hitIn(shown, within(shown.getBoundingClientRect(), windowArea()));
}

type Nearest = { within?: Element; toward?: { x: number; y: number } | undefined; inColumn?: boolean };

export function nearestBlock({ within, toward, inColumn = false }: Nearest): BlockId | undefined {
	const x = toward?.x ?? innerWidth / 2;
	const y = toward?.y ?? innerHeight / 2;
	const seen: { id: BlockId; distance: number }[] = [];
	for (const block of blocks.values()) {
		if (within && !within.contains(block.el)) continue;
		const { left, right, top, bottom, height } = shownBox(block);
		if (height === 0 || bottom <= 0 || top >= innerHeight || right <= 0 || left >= innerWidth) continue;
		if (inColumn && (x < left || x > right)) continue;
		seen.push({ id: block.id, distance: Math.hypot(Math.max(left - x, 0, x - right), Math.max(top - y, 0, y - bottom)) });
	}
	return seen.sort((a, b) => a.distance - b.distance).find(({ id }) => canBeHit(id))?.id;
}

export function setLevel(id: BlockId, level: Level): void {
	const block = blocks.get(id);
	if (!block) throw new Error(`no block ${id}`);
	if (block.level === level) return;
	const unfolded = block.level === 0;
	renderInPlace(block, () => {
		block.level = level;
	});
	levelChanged(level);
	watch();
	if (unfolded && level !== 0) {
		fetchFolds(id, { retryFailed: false });
		noteFolded(id, connectedBlocks(), textOf, (target) => fetchFolds(target, { retryFailed: false }));
	}
}

export function fetchRun(ids: readonly BlockId[], anchor: BlockId): void {
	const steady = blocks.get(anchor);
	const askAll = () => {
		for (const id of ids) fetchFolds(id);
	};
	// Asking again takes a failure's badge off, and that moves what is below it.
	if (steady && ids.length > 1) holdStill(steady, askAll);
	else askAll();
}

// One move for a run of blocks, in top to bottom order, with the anchor held where it is. Asking ahead counts once for the
// whole move, as it does for the fold of one paragraph.
export function setLevels(ids: readonly BlockId[], level: Level, anchor: BlockId): boolean {
	const group = ids.flatMap((id) => {
		const block = blocks.get(id);
		return block && block.level !== level ? [block] : [];
	});
	const steady = blocks.get(anchor);
	if (group.length === 0 || !steady) return false;
	if (ids.length === 1) {
		lastRunAnchor &&= anchor;
		setLevel(anchor, level);
		return true;
	}
	lastRunAnchor = anchor;
	const opening = group.filter((block) => block.level === 0);
	changeTogether(
		group,
		(block) => {
			block.level = level;
			render(block);
		},
		(changeAll) => keepInPlace(() => shownBox(steady), changeAll, scrollerOf(steady.el)),
	);
	levelChanged(level);
	watch();
	const last = opening.at(-1);
	if (level !== 0 && last) {
		for (const { id } of opening) fetchFolds(id, { retryFailed: false });
		noteFolded(last.id, connectedBlocks(), textOf, (target) => fetchFolds(target, { retryFailed: false }));
	}
	return true;
}

const connectedBlocks = () => [...blocks.values()].filter((block) => block.el.isConnected);

export function fetchFolds(id: BlockId, { retryFailed } = { retryFailed: true }): void {
	for (const asked of requestFolds(id, connectedBlocks(), textOf, swapIn, retryFailed)) {
		const block = blocks.get(asked);
		if (block && block.level !== 0) render(block);
	}
}

export function unfoldAll(): void {
	parked.clear();
	stopAskingAhead();
	for (const block of folded()) setLevel(block.id, 0);
	watch();
}

export function release(): void {
	stopAskingAhead();
	lastRunAnchor = undefined;
	for (const block of blocks.values()) block.overlay = restore(block.el, block.overlay);
	blocks.clear();
	parked.clear();
	watch();
}

export function readBlocks(): { id: BlockId; level: Level }[] {
	scan();
	return [...blocks.values()].map(({ id, level }) => ({ id, level }));
}
