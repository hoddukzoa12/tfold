import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { paragraphLanguage, translateFor } from '../../src/fold/language.ts';
import type { FoldRequest } from '../../src/fold/prompt.ts';
import { parseProvider, type FoldResult, type Provider } from '../../src/fold/providers/index.ts';
import { readCompletion } from '../../src/fold/providers/openai-compatible.ts';
import { providerIds, type ProviderId } from '../../src/fold/providers/presets.ts';
import { requestBody } from '../../src/fold/providers/request-body.ts';
import type { Fold } from '../../src/fold/types.ts';
import type { Language } from '../../src/i18n.ts';
import { requestTimeoutMs } from '../../src/messages.ts';
import type { StoredTranslation } from '../../src/translation.ts';

export const here = import.meta.dirname;
export const resultsDir = path.join(here, 'results');

export type Item = {
	id: string;
	page: string;
	startsWith: string;
	mainPoint: string;
	facts: string[];
	seen?: string;
	names?: string[];
};

export type Captured = {
	content: string;
	items: Record<string, { call: number; block: number }>;
	calls: FoldRequest[];
};

export type Checks = { briefShorter: boolean; language: boolean; finalStop: boolean; names?: boolean };

export type CallRecord = {
	call: number;
	blocks: number;
	status: number;
	ms: number;
	upstream: string;
	ok: boolean;
	detail: string;
	promptTokens: number;
	completionTokens: number;
	cost: number;
	blank?: number;
	content?: string;
};

export type ItemRecord = { item: string; call: number; fold: Fold | null; checks: Checks | null };

export type Run = {
	label: string;
	repeat: number;
	promptVersion: number;
	model: string;
	commit: string;
	provider: ProviderId;
	startedAt: string;
	set?: SetName;
	translateTo?: Language;
	calls: CallRecord[];
	items: ItemRecord[];
};

export type Verdict = {
	item: string;
	run: string;
	label: string;
	unsupported: string;
	faithful: boolean;
	mainPoint: boolean;
	completeSentence: boolean;
	naturalKorean?: boolean;
	properNouns?: boolean;
};

export type Judged = { model: string; runs: string[]; cost: number; verdicts: Verdict[]; missing?: string[] };

export const sets = {
	main: { items: 'set.json', requests: 'requests.json', stored: {} },
	translate: { items: 'translate-set.json', requests: 'requests-translate.json', stored: { autoTranslate: true, readerLanguage: 'ko' } },
} satisfies Record<string, { items: string; requests: string; stored: StoredTranslation }>;
export type SetName = keyof typeof sets;

export async function readJson<T>(file: string): Promise<T> {
	return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, '\t')}\n`);
}

export const readSet = (name: SetName) => readJson<Item[]>(path.join(here, sets[name].items));
export const readCaptured = (name: SetName) => readJson<Captured>(path.join(here, sets[name].requests));

export function commit(): string {
	return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
}

export function arg(name: string, fallback?: string): string {
	const at = process.argv.indexOf(`--${name}`);
	const value = at === -1 ? fallback : process.argv[at + 1];
	if (value === undefined) throw new Error(`--${name} is required`);
	return value;
}

const keyNames: Record<ProviderId, string> = { opengateway: 'OPENGATEWAY_API_KEY', openrouter: 'OPENROUTER_API_KEY' };

export function product(id: ProviderId): Provider {
	const apiKey = process.env[keyNames[id]];
	if (!apiKey) throw new Error(`${keyNames[id]} is not set`);
	return parseProvider(id, { apiKey });
}

export function setArg(): SetName {
	const name = arg('set', 'main');
	const known = (Object.keys(sets) as SetName[]).find((each) => each === name);
	if (!known) throw new Error(`--set is one of ${Object.keys(sets).join(', ')}`);
	return known;
}

export function providerArg(): Provider {
	const id = arg('provider', 'openrouter');
	const known = providerIds.find((each) => each === id);
	if (!known) throw new Error(`--provider is one of ${providerIds.join(', ')}`);
	return product(known);
}

export type Answer = { status: number; ms: number; text: string };

export async function post(provider: Provider, body: unknown, timeoutMs: number): Promise<Answer> {
	const started = performance.now();
	try {
		const response = await fetch(`${provider.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		return { status: response.status, ms: Math.round(performance.now() - started), text };
	} catch (error) {
		return { status: 0, ms: Math.round(performance.now() - started), text: error instanceof Error ? error.name : 'fetch failed' };
	}
}

export const openRouter = (body: unknown, timeoutMs: number) => post(product('openrouter'), body, timeoutMs);

export type Completion = { provider?: string; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number } };

export function parseCompletion(text: string): (Completion & Record<string, unknown>) | undefined {
	try {
		const body: unknown = JSON.parse(text);
		return typeof body === 'object' && body !== null ? (body as Completion & Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function blankUnits(request: FoldRequest, content: unknown): number {
	if (typeof content !== 'string') return 0;
	try {
		const { units } = JSON.parse(content) as { units?: { id?: unknown; takeaway?: unknown }[] };
		const long = (id: unknown) => (request.blocks[Number(String(id).slice(1))]?.sentences.length ?? 0) > 1;
		return (units ?? []).filter((unit) => unit.takeaway === '' && long(unit.id)).length;
	} catch {
		return 0;
	}
}

export async function foldCall(
	provider: Provider,
	request: FoldRequest,
	call: number,
	routing?: object,
): Promise<{ record: CallRecord; result: FoldResult }> {
	const body = requestBody(provider, request);
	const answer = await post(provider, routing ? { ...body, provider: routing } : body, requestTimeoutMs);
	const parsed = parseCompletion(answer.text);
	const result: FoldResult =
		answer.status === 0
			? { ok: false, error: 'network', detail: answer.text, busy: false }
			: answer.status !== 200
				? { ok: false, error: 'failed', detail: `HTTP ${answer.status}`, busy: false }
				: readCompletion(request, parsed ?? answer.text);
	const choices = parsed?.choices as { message?: { content?: unknown } }[] | undefined;
	const content = choices?.[0]?.message?.content;
	const blank = result.ok ? blankUnits(request, content) : 0;
	return {
		result,
		record: {
			call,
			blocks: request.blocks.length,
			status: answer.status,
			ms: answer.ms,
			upstream: parsed?.provider ?? '-',
			ok: result.ok,
			detail: result.ok ? '' : `${result.error}, ${result.detail}`,
			promptTokens: parsed?.usage?.prompt_tokens ?? 0,
			completionTokens: parsed?.usage?.completion_tokens ?? 0,
			cost: parsed?.usage?.cost ?? 0,
			blank,
			...(result.ok && blank === 0 ? {} : { content: typeof content === 'string' ? content : answer.text.slice(0, 2000) }),
		},
	};
}

const letters = (text: string) => [...text].filter((c) => /\p{L}/u.test(c));
const hangulShare = (text: string) => {
	const all = letters(text);
	return all.length === 0 ? 0 : all.filter((c) => /\p{Script=Hangul}/u.test(c)).length / all.length;
};

const glossedInKorean = /^\([^)]*\p{Script=Hangul}[^)]*\)/u;

function namesGlossed(lines: string[], names: string[]): boolean | undefined {
	const uses = lines.flatMap((line) =>
		names.flatMap((name) => {
			const at = line.indexOf(name);
			return at === -1 ? [] : [glossedInKorean.test(line.slice(at + name.length))];
		}),
	);
	return uses.length === 0 ? undefined : uses.every(Boolean);
}

export function checksOf(sentences: string[], fold: Fold, translateTo?: Language, names: string[] = []): Checks {
	const verbatim = fold.brief.every((i) => fold.sentences[i] !== undefined) && fold.sentences.join('\n') === sentences.join('\n');
	const brief = fold.brief.map((i) => fold.sentences[i] ?? '').join(' ');
	const korean = hangulShare(sentences.join(' ')) > 0.5;
	const written = `${fold.key} ${fold.takeaway}`;
	const glossed = translateTo === 'ko' ? namesGlossed([fold.takeaway, fold.key], names) : undefined;
	return {
		briefShorter: verbatim && brief.length < sentences.join(' ').length,
		language: translateTo ? translateFor(paragraphLanguage('', written), translateTo) === undefined : korean ? hangulShare(written) > 0.5 : hangulShare(written) === 0,
		finalStop: /[.!?。！？]["'”’)\]]*$/u.test(fold.takeaway.trim()),
		...(glossed === undefined ? {} : { names: glossed }),
	};
}

export function seeded(seed: string): () => number {
	let state = [...seed].reduce((hash, c) => Math.imul(hash ^ c.charCodeAt(0), 0x01000193), 0x811c9dc5) >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
