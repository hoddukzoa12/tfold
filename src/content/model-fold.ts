import { paragraphLanguage, translateFor } from '../fold/language.ts';
import { isShortLine, localFold } from '../fold/local.ts';
import type { FoldRequest, Heading } from '../fold/prompt.ts';
import type { FoldError } from '../fold/providers/index.ts';
import type { BlockId, Fold } from '../fold/types.ts';
import type { Language } from '../i18n.ts';
import { ask, failedWaitMs, replyDeadlineMs, type FoldReply } from '../messages.ts';
import { translationKeys, translationTarget } from '../translation.ts';
import { connected } from './connection.ts';
import { depthOf, headingText, inReadingOrder, pageHeadings, sectionOf } from './sections.ts';

export type Status = { state: 'idle' } | { state: 'pending' } | { state: 'failed'; error: FoldError };
export type Shown = { from: 'model'; fold: Fold } | { from: 'local'; fold: Fold; status: Status };
export type Member = { id: BlockId; el: Element };

type Asked = { text: string; lang: string; translateTo: Language | undefined };
type Remote = ({ state: 'pending' } & Asked) | { state: 'failed'; error: FoldError; at: number } | ({ state: 'done'; fold: Fold } & Asked);

// A paragraph answers in about 74 output tokens (p95 109), and a slow upstream writes one every 10.3 ms at p95
// after its first byte at 1.2 s p95, over 226 OpenRouter calls. Eight paragraphs then take about 10 s at p95,
// inside the 12 s timeout, where twelve would take about 15 s.
export const windowSize = 8;
// A translated paragraph answers in about twice the output tokens, 124 to 143 against 64 to 67, and OpenRouter writes
// one every 6 ms. Over 18 calls per size, three translated paragraphs took 4.3 s at worst, inside the 6 s that a first
// try gets and under the 4.8 s of eight untranslated ones, where four took 10 s and eight 12.3 s.
export const translatedWindowSize = 3;

const nearMiddle = '-35% 0px -35% 0px';
const foldsThatAskAhead = 2;

type Ahead = { window: ReadonlySet<BlockId>; folded: Set<BlockId>; paid: boolean };
type AskAhead = (target: BlockId) => void;

const remote = new Map<BlockId, Remote>();
let reader: Language | undefined;
let ahead: Ahead | undefined;
let aheadWatcher: IntersectionObserver | undefined;

async function readTranslation(): Promise<void> {
	try {
		const stored = await chrome.storage.sync.get([...translationKeys]);
		if (connected()) reader = translationTarget(stored);
	} catch (error) {
		if (connected()) throw error;
	}
}

export function watchTranslation(): void {
	void readTranslation();
	chrome.storage.onChanged.addListener((changes, area) => {
		if (connected() && area === 'sync' && translationKeys.some((key) => key in changes)) void readTranslation();
	});
}

function askFor(el: Element, text: string): Asked {
	const language = paragraphLanguage(el.closest('[lang]')?.getAttribute('lang') ?? '', text);
	return { text, lang: language.known ? language.lang : '', translateTo: translateFor(language, reader) };
}

const answers = (known: Remote | undefined, { text, translateTo }: Asked) =>
	known !== undefined && known.state !== 'failed' && known.text === text && known.translateTo === translateTo;

const stillWaiting = (known: Remote | undefined, now: number) => known?.state === 'failed' && now - known.at < failedWaitMs;

// A short line has nothing to shorten, so it costs a request only when it needs translating.
const wantsModel = ({ text, translateTo }: Asked) => translateTo !== undefined || !isShortLine(text);

const writtenAlike = (a: Asked, b: Asked) => a.lang === b.lang && a.translateTo === b.translateTo;

export function foldFor(id: BlockId, text: string): Shown {
	const known = remote.get(id);
	if (known?.state === 'done' && known.text === text) return { from: 'model', fold: known.fold };
	return { from: 'local', fold: localFold(text), status: known && known.state !== 'done' ? known : { state: 'idle' } };
}

// The sample paragraph in settings ships its own levels. With its answer known, asking for it never reaches the worker.
export function answerWith(id: BlockId, text: string, fold: Fold): void {
	remote.set(id, { state: 'done', fold, text, lang: '', translateTo: undefined });
}

function around<T>(items: T[], at: number, size: number, open: (item: T) => boolean): T[] {
	const picked = [at];
	for (let step = 1; picked.length < size && step < items.length; step++) {
		for (const i of [at + step, at - step]) {
			const item = items[i];
			if (picked.length < size && item !== undefined && open(item)) picked.push(i);
		}
	}
	return picked.sort((a, b) => a - b).map((i) => items[i] as T);
}

// A fold on its way when tfold reloads, updates or goes away fails up to 25 ms before Chrome cuts this script off, so
// a send that fails waits before it counts as a failure of tfold's own.
const cutOffGraceMs = 500;

function send(request: FoldRequest): Promise<FoldReply> {
	const reply = ask({ type: 'fold', request }).then(async (answer): Promise<FoldReply> => {
		if (answer) return answer;
		await new Promise((resolve) => setTimeout(resolve, cutOffGraceMs));
		return { ok: false, error: 'failed' };
	});
	const deadline = new Promise<FoldReply>((resolve) => setTimeout(() => resolve({ ok: false, error: 'network' }), replyDeadlineMs));
	return Promise.race([reply, deadline]);
}

export function requestFolds(
	target: BlockId,
	blocks: Member[],
	textOf: (el: Element) => string,
	settled: (ids: BlockId[]) => void,
	retryFailed: boolean,
): BlockId[] {
	const targetEl = blocks.find((block) => block.id === target)?.el;
	if (!targetEl) return [];
	const known = remote.get(target);
	const asked = askFor(targetEl, textOf(targetEl));
	const now = performance.now();
	if (!wantsModel(asked) || answers(known, asked) || (known?.state === 'failed' && !retryFailed) || stillWaiting(known, now)) return [];
	const headings = pageHeadings();
	const section = sectionOf(targetEl, headings);
	const members = blocks
		.filter((block) => sectionOf(block.el, headings) === section)
		.sort(inReadingOrder)
		.map((block) => ({ ...block, ...askFor(block.el, textOf(block.el)) }));
	const window = around(
		members,
		members.findIndex((member) => member.id === target),
		asked.translateTo ? translatedWindowSize : windowSize,
		(member) => wantsModel(member) && writtenAlike(member, asked) && !answers(remote.get(member.id), member) && !stillWaiting(remote.get(member.id), now),
	);
	const asking = window.map(({ id, text, lang, translateTo }) => [id, { state: 'pending', text, lang, translateTo }] as const);
	for (const [id, pending] of asking) remote.set(id, pending);
	const request: FoldRequest = {
		url: location.origin + location.pathname + location.search,
		title: document.title,
		lang: asked.lang,
		outline: headings.map((heading): Heading => ({ depth: depthOf(heading), text: headingText(heading) })),
		section,
		blocks: window.map(({ id, el, text }) => ({ id, tag: el.localName, sentences: localFold(text).sentences })),
		...(asked.translateTo ? { translateTo: asked.translateTo } : {}),
	};
	stopWatchingAhead();
	ahead = asked.translateTo ? { window: new Set(window.map((member) => member.id)), folded: new Set(), paid: false } : undefined;
	void send(request).then((reply) => {
		if (!connected()) return;
		const answered = asking.flatMap(([id, pending], i) => {
			if (remote.get(id) !== pending) return [];
			const fold = reply.ok ? reply.folds[i] : undefined;
			remote.set(id, fold ? { ...pending, state: 'done', fold } : { state: 'failed', error: reply.ok ? 'failed' : reply.error, at: performance.now() });
			return [id];
		});
		if (!reply.ok) stopAskingAhead();
		settled(answered);
	});
	return window.map((member) => member.id);
}

function stopWatchingAhead(): void {
	aheadWatcher?.disconnect();
	aheadWatcher = undefined;
}

export function stopAskingAhead(): void {
	stopWatchingAhead();
	ahead = undefined;
}

function nextUnasked(window: ReadonlySet<BlockId>, blocks: Member[], textOf: (el: Element) => string): Member | undefined {
	const inOrder = [...blocks].sort(inReadingOrder);
	const last = inOrder.findLastIndex((member) => window.has(member.id));
	return inOrder.slice(last + 1).find((member) => {
		const asked = askFor(member.el, textOf(member.el));
		return asked.translateTo !== undefined && !answers(remote.get(member.id), asked) && remote.get(member.id)?.state !== 'failed';
	});
}

export function noteFolded(id: BlockId, blocks: Member[], textOf: (el: Element) => string, ask: AskAhead): void {
	if (!ahead) return;
	ahead.paid = true;
	if (ahead.window.has(id)) ahead.folded.add(id);
	const next = nextUnasked(ahead.window, blocks, textOf);
	if (!next) return;
	if (ahead.folded.size === foldsThatAskAhead) {
		ahead.paid = false;
		ask(next.id);
		return;
	}
	stopWatchingAhead();
	aheadWatcher = new IntersectionObserver(
		(entries) => {
			if (!connected() || !ahead?.paid || !entries.some((entry) => entry.isIntersecting)) return;
			ahead.paid = false;
			stopWatchingAhead();
			ask(next.id);
		},
		{ rootMargin: nearMiddle },
	);
	aheadWatcher.observe(next.el);
}
