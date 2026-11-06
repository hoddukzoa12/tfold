import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Fold } from '../../src/fold/types.ts';
import {
	arg,
	openRouter,
	parseCompletion,
	readCaptured,
	readJson,
	readSet,
	resultsDir,
	seeded,
	setArg,
	writeJson,
	type Item,
	type Judged,
	type Run,
	type Verdict,
} from './lib.ts';

const model = arg('model', 'anthropic/claude-sonnet-5.5');
const name = setArg();
const runs = arg('runs').split(',');
const out = arg('out');
const only = arg('items', '').split(',').filter((id) => id !== '');

const rubric = `You check short summaries of a paragraph for a reading tool. A reader sees a summary in place of the paragraph and trusts it, so a summary that says what the paragraph does not say is worse than none.

You get the paragraph, a reference note a person wrote about it (its main point and key facts), and several summaries labelled F1, F2 and so on. Each summary has a Key of one or two sentences and a Takeaway of one sentence. The summaries are independent attempts: judge each one on its own.

For each summary:
- unsupported: quote the shortest phrase of its Key or Takeaway that says something the paragraph does not say. That includes a fact, name or number the paragraph lacks; a claim stated more strongly than the paragraph states it (found, thought or suggested becomes confirmed, proven or established; may becomes does; candidates become black holes); a hedge dropped; a cause, actor or role swapped or merged (one process forms it and another grows it becomes both grow it); and a wrong scope (some becomes all). Omissions, paraphrase, a plain gloss of a term and a compression that keeps the meaning are fine. The paragraph decides, not the reference note. Use "" when there is none.
- faithful: true exactly when unsupported is "".
- main_point: true when the Takeaway states the paragraph's main point, the one in the reference note or an equivalent one. False when it states a detail, an example or one fact among several instead of what the paragraph as a whole establishes.
- complete_sentence: true when the Takeaway is a grammatical, complete sentence in its own language, ignoring punctuation. A Korean sentence ends in a predicate such as 다 or 이다; a noun phrase or a 함 or 음 ending is not complete. An English headline without a finite verb is not complete.`;

const translationRubric = `

The paragraph is in English. Some summaries are in Korean, written for a Korean reader. Judge a Korean summary's meaning across the two languages: a faithful translation is a paraphrase, and a Korean name or term that renders one of the paragraph's adds nothing, while a mistranslation that changes a fact, a number or a name is unsupported. For a Korean summary also give:
- natural_korean: true when the Key and the Takeaway read as natural written Korean that a Korean writer would produce, with fitting particles and endings and Korean word order. Proper nouns and technical terms left in English are fine. False for translationese that copies the English structure so that it reads awkwardly, for a wrong particle after an English name, or for an ordinary English word left where Korean has a usual one.
- proper_nouns: true when each person, organization, company, product, named work or named technical term (a named method, policy or standard) that the summary names appears first in the paragraph's own spelling with its Korean name in parentheses right after it, as in Neil Armstrong(닐 암스트롱), in the Takeaway and again in the Key. Later mentions may use the original alone, and a name that Korean writers spell the same way, such as GPT-4 or TSMC, may stand alone. A Korean person or a Korean organization is written by its Korean name in Hangul alone, as in 봉준호 or 삼성전자. A country, a major city or another place that Korean readers know by its Korean name is written in Korean alone, as in 중국, 미국, 서울 or 런던, and a lesser-known place may take either form. False when such a name appears only in Korean, appears first in the original with no Korean, or puts the Korean first and the original in parentheses, false when a Korean person or a Korean organization keeps its original spelling, as in Bong Joon-ho(봉준호), and false when a country or a major city keeps its original spelling. True when the summary names none of these.
For a summary in English, give natural_korean and proper_nouns as true.`;

const verdictFields = {
	label: { type: 'string' },
	unsupported: { type: 'string' },
	faithful: { type: 'boolean' },
	main_point: { type: 'boolean' },
	complete_sentence: { type: 'boolean' },
};
const translationFields = { natural_korean: { type: 'boolean' }, proper_nouns: { type: 'boolean' } };

function schemaFor(translated: boolean) {
	const properties = translated ? { ...verdictFields, ...translationFields } : verdictFields;
	return {
		type: 'object',
		properties: {
			verdicts: {
				type: 'array',
				items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
			},
		},
		required: ['verdicts'],
		additionalProperties: false,
	};
}

type Entry = { run: string; label: string; fold: Fold };
type Answer = {
	verdicts: {
		label: string;
		unsupported: string;
		faithful: boolean;
		main_point: boolean;
		complete_sentence: boolean;
		natural_korean?: boolean;
		proper_nouns?: boolean;
	}[];
};

async function loadRuns(): Promise<Run[]> {
	const loaded: Run[] = [];
	for (const label of runs) {
		const dir = path.join(resultsDir, label);
		for (const file of (await readdir(dir)).filter((entry) => /^r\d+\.json$/.test(entry)).sort()) {
			loaded.push(await readJson<Run>(path.join(dir, file)));
		}
	}
	return loaded;
}

function message(item: Item, sentences: string[], entries: Entry[]): string {
	const summaries = entries.map(({ label, fold }) => `${label}\nKey: ${fold.key}\nTakeaway: ${fold.takeaway}`);
	return `Paragraph:\n${sentences.join(' ')}\n\nReference note:\nMain point: ${item.mainPoint}\nKey facts:\n${item.facts
		.map((fact) => `- ${fact}`)
		.join('\n')}\n\nSummaries:\n\n${summaries.join('\n\n')}`;
}

const perCall = 20;

async function judgeChunk(item: Item, sentences: string[], chunk: Entry[], korean: Set<string>, translated: boolean): Promise<{ verdicts: Verdict[] | undefined; cost: number }> {
	let cost = 0;
	for (let attempt = 0; attempt < 3; attempt++) {
		const answer = await openRouter(
			{
				model,
				messages: [
					{ role: 'system', content: translated ? rubric + translationRubric : rubric },
					{ role: 'user', content: message(item, sentences, chunk) },
				],
				response_format: { type: 'json_schema', json_schema: { name: 'verdicts', strict: true, schema: schemaFor(translated) } },
				provider: { require_parameters: true },
				reasoning: { effort: 'low' },
				max_tokens: 4000 + 200 + (translated ? 240 : 120) * chunk.length,
			},
			120_000,
		);
		const parsed = parseCompletion(answer.text);
		cost += parsed?.usage?.cost ?? 0;
		console.log(`${item.id}: via ${String(parsed?.provider ?? '-')}, ${JSON.stringify(parsed?.usage ?? {})}`);
		const choices = parsed?.choices as { message?: { content?: string } }[] | undefined;
		try {
			const { verdicts } = JSON.parse(choices?.[0]?.message?.content ?? '') as Answer;
			const mapped = chunk.map(({ run, label, fold }): Verdict => {
				const written = fold.writtenIn === 'ko';
				const verdict = verdicts.find((candidate) => candidate.label === label);
				if (!verdict) throw new Error(`no verdict for ${label}`);
				return {
					item: item.id,
					run,
					label,
					unsupported: verdict.unsupported,
					faithful: verdict.faithful,
					mainPoint: verdict.main_point,
					completeSentence: verdict.complete_sentence,
					...(korean.has(run) ? { naturalKorean: written && verdict.natural_korean === true, properNouns: written && verdict.proper_nouns === true } : {}),
				};
			});
			return { verdicts: mapped, cost };
		} catch (error) {
			console.log(`${item.id}: attempt ${attempt} failed, HTTP ${answer.status}, ${String(error)}, ${answer.text.slice(0, 300)}`);
		}
	}
	return { verdicts: undefined, cost };
}

async function judgeItem(item: Item, sentences: string[], loaded: Run[], translated: boolean): Promise<{ verdicts: Verdict[] | undefined; cost: number }> {
	const korean = new Set(loaded.filter((run) => run.translateTo === 'ko').map((run) => `${run.label}/r${run.repeat}`));
	const folds = loaded.flatMap((run) => {
		const fold = run.items.find((record) => record.item === item.id)?.fold;
		return fold ? [{ run: `${run.label}/r${run.repeat}`, fold }] : [];
	});
	const random = seeded(`${out}:${item.id}`);
	const shuffled = folds
		.map((entry) => ({ entry, key: random() }))
		.sort((a, b) => a.key - b.key)
		.map(({ entry }, i): Entry => ({ ...entry, label: `F${i + 1}` }));
	const verdicts: Verdict[] = [];
	let cost = 0;
	for (let start = 0; start < shuffled.length; start += perCall) {
		const judged = await judgeChunk(item, sentences, shuffled.slice(start, start + perCall), korean, translated);
		cost += judged.cost;
		if (!judged.verdicts) return { verdicts: undefined, cost };
		verdicts.push(...judged.verdicts);
	}
	return { verdicts, cost };
}

const [set, captured, loaded] = await Promise.all([readSet(name), readCaptured(name), loadRuns()]);
const translated = loaded.some((run) => run.translateTo !== undefined);
if (loaded.some((run) => run.translateTo !== undefined && run.translateTo !== 'ko')) throw new Error('the judge reads translations into Korean only');
const items = set.filter((item) => only.length === 0 || only.includes(item.id));
const missing: string[] = [];
const judged: Judged = { model, runs, cost: 0, verdicts: [], missing };
const queue = [...items];
await Promise.all(
	Array.from({ length: 4 }, async () => {
		for (let item = queue.shift(); item; item = queue.shift()) {
			const at = captured.items[item.id];
			const sentences = at ? (captured.calls[at.call]?.blocks[at.block]?.sentences ?? []) : [];
			const { verdicts, cost } = await judgeItem(item, sentences, loaded, translated);
			judged.cost += cost;
			if (!verdicts) {
				missing.push(item.id);
				console.log(`${item.id}: the judge gave no usable answer in 3 attempts, left out`);
				continue;
			}
			judged.verdicts.push(...verdicts);
			const mark = (on: boolean | undefined, letter: string) => (on === undefined ? '' : on ? letter : letter.toLowerCase());
			const marks = (v: Verdict) =>
				`${mark(v.faithful, 'F')}${mark(v.mainPoint, 'M')}${mark(v.completeSentence, 'S')}${mark(v.naturalKorean, 'K')}${mark(v.properNouns, 'N')}`;
			console.log(`${item.id}: ${verdicts.map((v) => `${v.run} ${marks(v)}`).join(' ')}`);
		}
	}),
);
judged.verdicts.sort((a, b) => a.item.localeCompare(b.item) || a.run.localeCompare(b.run));
await writeJson(path.join(resultsDir, `judge-${out}.json`), judged);
console.log(`${judged.verdicts.length} verdicts on ${items.length - missing.length} of ${items.length} items by ${model}, $${judged.cost.toFixed(4)}`);
if (missing.length > 0) console.log(`not judged: ${missing.join(', ')}`);
