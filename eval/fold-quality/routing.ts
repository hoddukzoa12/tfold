import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FoldRequest } from '../../src/fold/prompt.ts';
import { arg, foldCall, here, product, readJson, resultsDir, writeJson, type CallRecord } from './lib.ts';

const arms = {
	default: { require_parameters: true },
	'no-together': { require_parameters: true, ignore: ['together'] },
	together: { require_parameters: true, only: ['together'] },
} as const;
type Arm = keyof typeof arms;
type Routed = CallRecord & { pass: number; arm: Arm };

const pass = Number(arg('pass'));
const file = path.join(resultsDir, 'routing.json');
const { calls } = await readJson<{ calls: FoldRequest[] }>(path.join(here, 'sections.json'));
const rows = existsSync(file) ? await readJson<Routed[]>(file) : [];
const chosen = arg('arms', 'default,no-together').split(',') as Arm[];
const order = pass % 2 === 0 ? chosen : chosen.toReversed();
const limit = Number(arg('limit', String(calls.length)));

for (const [call, request] of calls.slice(0, limit).entries()) {
	const arm = order[call % order.length] ?? 'default';
	const { record } = await foldCall(product('openrouter'), request, call, arms[arm]);
	rows.push({ pass, arm, ...record });
	console.log(`pass ${pass} call ${call} ${arm}: ${record.ok ? 'ok' : record.detail}, ${record.ms} ms, ${record.upstream}`);
}
await writeJson(file, rows);

const pick = (values: number[], q: number) => values.toSorted((a, b) => a - b)[Math.ceil(q * values.length) - 1] ?? NaN;
for (const arm of Object.keys(arms) as Arm[]) {
	const mine = rows.filter((row) => row.arm === arm);
	if (mine.length === 0) continue;
	const ms = mine.map((row) => (row.ok ? row.ms : Infinity));
	const upstreams = new Map<string, number>();
	for (const row of mine) upstreams.set(row.upstream, (upstreams.get(row.upstream) ?? 0) + 1);
	console.log(
		`${arm}: ${mine.length} calls over ${new Set(mine.map((row) => row.pass)).size} passes, median ${pick(ms, 0.5)} ms, p95 ${pick(ms, 0.95)} ms, ` +
			`schema failures ${mine.filter((row) => row.status === 200 && !row.ok).length}, other failures ${mine.filter((row) => row.status !== 200).length}, ` +
			`$${mine.reduce((sum, row) => sum + row.cost, 0).toFixed(4)}, upstreams ${[...upstreams].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(', ')}`,
	);
}
