import { spawnSync } from 'node:child_process';

const runs = 10;
const budgetMs = 5000;
const bootMs: number[] = [];

for (let run = 1; run <= runs; run++) {
	const result = spawnSync('npm', ['run', 'e2e', '--', 'smoke'], { encoding: 'utf8' });
	const match = /extension ready \S+ in (\d+) ms/.exec(result.stdout);
	if (result.status !== 0 || !match) {
		process.stderr.write(result.stdout + result.stderr);
		throw new Error(`run ${run} exited ${result.status} without an extension ready line`);
	}
	bootMs.push(Number(match[1]));
	console.log(`run ${run}: boot ${match[1]} ms`);
}

const sorted = bootMs.toSorted((a, b) => a - b);
const median = ((sorted[(runs - 1) >> 1] ?? NaN) + (sorted[runs >> 1] ?? NaN)) / 2;
console.log(`median boot ${median} ms over ${runs} runs, range ${sorted[0]} to ${sorted.at(-1)} ms, budget ${budgetMs} ms`);
if (median > budgetMs) process.exitCode = 1;
