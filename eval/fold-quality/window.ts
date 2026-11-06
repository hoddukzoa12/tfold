import path from 'node:path';
import type { FoldRequest } from '../../src/fold/prompt.ts';
import { readCompletion } from '../../src/fold/providers/openai-compatible.ts';
import { requestBody } from '../../src/fold/providers/request-body.ts';
import { arg, parseCompletion, post, providerArg, readCaptured, resultsDir, writeJson } from './lib.ts';

type Arm = { label: string; size: number; translated: boolean };
type Row = Arm & {
	round: number;
	window: number;
	status: number;
	ms: number;
	upstream: string;
	ok: boolean;
	detail: string;
	promptTokens: number;
	completionTokens: number;
	cost: number;
};

const provider = providerArg();
const sizes = arg('sizes', '1,2,3,4,8').split(',').map(Number);
const ownSize = Number(arg('own', '8'));
const rounds = Number(arg('rounds', '6'));
const perRound = Number(arg('calls', '3'));
const timeoutMs = 30_000;
const arms: Arm[] = [
	...sizes.map((size) => ({ label: `translated ${size}`, size, translated: true })),
	{ label: `untranslated ${ownSize}`, size: ownSize, translated: false },
];

const { calls } = await readCaptured('translate');
const blocks = calls.flatMap((request) => request.blocks.map((block) => ({ request, block })));

function windowOf({ size, translated }: Arm, n: number): FoldRequest {
	const count = Math.floor(blocks.length / size);
	const chunk = blocks.slice((n % count) * size, (n % count) * size + size);
	const head = chunk[0]?.request;
	if (!head) throw new Error('the translation set has no requests, run capture first');
	const request: FoldRequest = { ...head, blocks: chunk.map(({ block }) => block) };
	if (!translated) delete request.translateTo;
	return request;
}

const rows: Row[] = [];
for (let round = 0; round < rounds; round++) {
	const order = [...arms.slice(round % arms.length), ...arms.slice(0, round % arms.length)];
	for (let k = 0; k < perRound; k++) {
		for (const arm of order) {
			const window = round * perRound + k;
			const request = windowOf(arm, window);
			const answer = await post(provider, requestBody(provider, request), timeoutMs);
			const parsed = parseCompletion(answer.text);
			const result = answer.status === 200 ? readCompletion(request, parsed ?? answer.text) : undefined;
			const row: Row = {
				...arm,
				round,
				window,
				status: answer.status,
				ms: answer.ms,
				upstream: parsed?.provider ?? '-',
				ok: result?.ok ?? false,
				detail: result ? (result.ok ? '' : result.detail) : answer.status === 0 ? answer.text : `HTTP ${answer.status}`,
				promptTokens: parsed?.usage?.prompt_tokens ?? 0,
				completionTokens: parsed?.usage?.completion_tokens ?? 0,
				cost: parsed?.usage?.cost ?? 0,
			};
			rows.push(row);
			console.log(`${provider.id} r${round} ${arm.label}: ${row.ok ? 'ok' : row.detail}, ${row.ms} ms, ${row.completionTokens} output tokens, ${row.upstream}`);
		}
	}
}
await writeJson(path.join(resultsDir, 'window', `${provider.id}.json`), rows);

const pick = (values: number[], q: number) => values.toSorted((a, b) => a - b)[Math.ceil(q * values.length) - 1] ?? NaN;
for (const arm of arms) {
	const mine = rows.filter((row) => row.label === arm.label);
	const ms = mine.map((row) => (row.ok ? row.ms : Infinity));
	console.log(
		`${provider.id} ${arm.label}: ${mine.length} calls, ${mine.filter((row) => !row.ok).length} failed, median ${pick(ms, 0.5)} ms, ` +
			`p95 ${pick(ms, 0.95)} ms, max ${Math.max(...ms)} ms, median ${pick(
				mine.map((row) => row.completionTokens),
				0.5,
			)} output tokens, $${mine.reduce((sum, row) => sum + row.cost, 0).toFixed(5)}`,
	);
}
const answered = rows.filter((row) => row.ok);
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const [tokens, ms] = [answered.map((row) => row.completionTokens), answered.map((row) => row.ms)];
const slope =
	answered.reduce((sum, row) => sum + (row.completionTokens - mean(tokens)) * (row.ms - mean(ms)), 0) /
	answered.reduce((sum, row) => sum + (row.completionTokens - mean(tokens)) ** 2, 0);
console.log(`${provider.id}: ${slope.toFixed(2)} ms per output token after ${(mean(ms) - slope * mean(tokens)).toFixed(0)} ms, over ${answered.length} answered calls`);
