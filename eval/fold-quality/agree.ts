import path from 'node:path';
import { arg, here, readJson, resultsDir, type Judged } from './lib.ts';

type Label = { item: string; run: string; faithful: boolean; mainPoint: boolean; note: string };

const judged = await readJson<Judged>(path.join(resultsDir, `judge-${arg('judge')}.json`));
const labels = await readJson<Label[]>(path.join(here, 'hand-labels.json'));

for (const field of ['faithful', 'mainPoint'] as const) {
	let agree = 0;
	const misses: string[] = [];
	for (const label of labels) {
		const verdict = judged.verdicts.find((v) => v.item === label.item && v.run === label.run);
		if (!verdict) throw new Error(`no verdict for ${label.item} ${label.run}`);
		if (verdict[field] === label[field]) agree++;
		else misses.push(`  ${label.item} ${label.run}: hand ${label[field]}, judge ${verdict[field]}. Hand: ${label.note} Judge: "${verdict.unsupported}"`);
	}
	const positive = labels.filter((label) => label[field]).length;
	console.log(`${field}: judge agrees on ${agree} of ${labels.length} folds (hand labels: ${positive} true, ${labels.length - positive} false)`);
	for (const miss of misses) console.log(miss);
}
