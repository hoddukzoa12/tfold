import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { arg, readJson, resultsDir, type Judged, type Run } from './lib.ts';

const labels = arg('runs').split(',');
const judged = await readJson<Judged>(path.join(resultsDir, `judge-${arg('judge')}.json`));
if ((judged.missing ?? []).length > 0) console.log(`The judge left out ${judged.missing?.join(', ')}, and the judged rates exclude them.\n`);

type Row = { name: string; rate: (run: Run, verdicts: Judged['verdicts']) => number; digits?: number };

const share = (hits: number, total: number) => (total === 0 ? NaN : hits / total);
const folded = (run: Run) => run.items.filter((record) => record.checks !== null);
const answered = (run: Run) => run.calls.filter((call) => call.ok);
const perParagraph = (run: Run, field: 'promptTokens' | 'completionTokens' | 'ms' | 'cost') =>
	answered(run).reduce((sum, call) => sum + call[field], 0) / answered(run).reduce((sum, call) => sum + call.blocks, 0);
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) / 2)] ?? NaN;
const judgedShare = (v: Judged['verdicts'], field: 'naturalKorean' | 'properNouns') => {
	const asked = v.filter((x) => x[field] !== undefined);
	return share(asked.filter((x) => x[field]).length, asked.length);
};
const glossed = (run: Run) => folded(run).filter((r) => r.checks?.names !== undefined);

const rows: Row[] = [
	{ name: '(a) faithful, Key and Takeaway', rate: (_, v) => share(v.filter((x) => x.faithful).length, v.length) },
	{ name: '(b) Takeaway states the main point', rate: (_, v) => share(v.filter((x) => x.mainPoint).length, v.length) },
	{ name: '(c) Brief shorter than Full, verbatim', rate: (run) => share(folded(run).filter((r) => r.checks?.briefShorter).length, folded(run).length) },
	{ name: '(d) language matches the source', rate: (run) => share(folded(run).filter((r) => r.checks?.language).length, folded(run).length) },
	{
		name: '(e) Takeaway a complete sentence with a final stop',
		rate: (run, v) =>
			share(v.filter((x) => x.completeSentence && run.items.find((r) => r.item === x.item)?.checks?.finalStop).length, v.length),
	},
	{ name: '(f) calls that failed the schema', rate: (run) => share(run.calls.filter((c) => c.status === 200 && !c.ok).length, run.calls.length) },
	{ name: 'calls that failed otherwise', rate: (run) => share(run.calls.filter((c) => c.status !== 200).length, run.calls.length) },
	{
		name: 'paragraphs of 2 or more sentences answered with no lines',
		rate: (run) => share(answered(run).reduce((sum, c) => sum + (c.blank ?? 0), 0), answered(run).reduce((sum, c) => sum + c.blocks, 0)),
	},
	{ name: '(g) natural Korean', rate: (_, v) => judgedShare(v, 'naturalKorean') },
	{ name: '(h) names in the original with Korean in parentheses', rate: (_, v) => judgedShare(v, 'properNouns') },
	{ name: '(h) listed names glossed, by code', rate: (run) => share(glossed(run).filter((r) => r.checks?.names).length, glossed(run).length) },
	{ name: 'input tokens per paragraph', rate: (run) => perParagraph(run, 'promptTokens'), digits: 0 },
	{ name: 'output tokens per paragraph', rate: (run) => perParagraph(run, 'completionTokens'), digits: 0 },
	{ name: 'call latency, median ms', rate: (run) => median(answered(run).map((call) => call.ms)), digits: 0 },
	{ name: 'latency per paragraph, ms', rate: (run) => perParagraph(run, 'ms'), digits: 0 },
	{ name: 'cost per paragraph, USD', rate: (run) => perParagraph(run, 'cost'), digits: 6 },
	{ name: 'cost per repeat, USD', rate: (run) => run.calls.reduce((sum, call) => sum + call.cost, 0), digits: 4 },
];

const loaded = new Map<string, Run[]>();
for (const label of labels) {
	const dir = path.join(resultsDir, label);
	const files = (await readdir(dir)).filter((name) => /^r\d+\.json$/.test(name)).sort();
	loaded.set(label, await Promise.all(files.map((file) => readJson<Run>(path.join(dir, file)))));
}

const verdictsOf = (run: Run) => judged.verdicts.filter((verdict) => verdict.run === `${run.label}/r${run.repeat}`);
const show = (value: number, digits: number | undefined) =>
	Number.isNaN(value) ? '-' : digits === undefined ? `${(value * 100).toFixed(0)}%` : value.toFixed(digits);

console.log(`| Criterion | ${labels.map((label) => `${label}, mean (repeats)`).join(' | ')} |`);
console.log(`| --- | ${labels.map(() => '---').join(' | ')} |`);
for (const row of rows) {
	const cells = labels.map((label) => {
		const values = (loaded.get(label) ?? []).map((run) => row.rate(run, verdictsOf(run)));
		const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
		return `${show(mean, row.digits)} (${values.map((value) => show(value, row.digits)).join(', ')})`;
	});
	console.log(`| ${row.name} | ${cells.join(' | ')} |`);
}

const all = [...loaded.values()].flat();
const upstreams = new Map<string, { calls: number; schema: number }>();
for (const call of all.flatMap((run) => run.calls)) {
	const tally = upstreams.get(call.upstream) ?? { calls: 0, schema: 0 };
	tally.calls++;
	if (call.status === 200 && !call.ok) tally.schema++;
	upstreams.set(call.upstream, tally);
}
console.log(`\nupstreams: ${[...upstreams].sort((a, b) => b[1].calls - a[1].calls).map(([name, t]) => `${name} ${t.calls} (${t.schema} schema failures)`).join(', ')}`);
for (const call of all.flatMap((run) => run.calls.filter((c) => !c.ok || (c.blank ?? 0) > 0).map((c) => ({ run: `${run.label}/r${run.repeat}`, ...c })))) {
	const what = call.ok ? `${call.blank} paragraphs with no lines` : call.detail;
	console.log(`failed: ${call.run} call ${call.call} via ${call.upstream}, ${what}, ${call.ms} ms: ${(call.content ?? '').slice(0, 160)}`);
}

console.log('\nper item, judged folds that fail (a), (b), (e), (g) or (h):');
for (const verdict of judged.verdicts.filter((v) => labels.some((label) => v.run.startsWith(`${label}/`)))) {
	const fails = { a: !verdict.faithful, b: !verdict.mainPoint, e: !verdict.completeSentence, g: verdict.naturalKorean === false, h: verdict.properNouns === false };
	const marks = Object.entries(fails)
		.filter(([, failed]) => failed)
		.map(([mark]) => mark)
		.join('');
	if (marks === '') continue;
	const run = all.find((r) => `${r.label}/r${r.repeat}` === verdict.run);
	const fold = run?.items.find((r) => r.item === verdict.item)?.fold;
	console.log(`${verdict.item} ${verdict.run} [${marks}] ${verdict.unsupported ? `unsupported "${verdict.unsupported}" ` : ''}| ${fold?.takeaway ?? ''} | ${fold?.key ?? ''}`);
}
