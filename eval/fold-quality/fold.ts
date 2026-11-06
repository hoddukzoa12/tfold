import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promptVersion, type FoldRequest } from '../../src/fold/prompt.ts';
import type { FoldResult } from '../../src/fold/providers/index.ts';
import { arg, checksOf, commit, foldCall, providerArg, readCaptured, readSet, resultsDir, setArg, writeJson, type Run } from './lib.ts';

const label = arg('label');
const provider = providerArg();
const name = setArg();
const untranslated = process.argv.includes('--untranslated');
const from = Number(arg('from', '0'));
const repeats = Number(arg('repeats', '3'));
const gapMs = Number(arg('gap', '0')) * 1000;
const [set, captured] = await Promise.all([readSet(name), readCaptured(name)]);

function inOwnLanguage(request: FoldRequest): FoldRequest {
	const copy = { ...request };
	delete copy.translateTo;
	return copy;
}

const calls = untranslated ? captured.calls.map(inOwnLanguage) : captured.calls;
const translateTo = calls.find((request) => request.translateTo)?.translateTo;
for (let repeat = from; repeat < repeats; repeat++) {
	if (repeat > from && gapMs > 0) await sleep(gapMs);
	const run: Run = {
		label,
		repeat,
		promptVersion,
		model: provider.model,
		commit: commit(),
		provider: provider.id,
		startedAt: new Date().toISOString(),
		set: name,
		...(translateTo ? { translateTo } : {}),
		calls: [],
		items: [],
	};
	const results: FoldResult[] = [];
	for (const [call, request] of calls.entries()) {
		const { record, result } = await foldCall(provider, request, call);
		run.calls.push(record);
		results.push(result);
		console.log(`${label} r${repeat} call ${call}: ${record.ok ? 'ok' : record.detail}, ${record.ms} ms, ${record.upstream}`);
	}
	for (const item of set) {
		const at = captured.items[item.id];
		if (!at) throw new Error(`${item.id} is not in ${name} requests, run capture again`);
		const result = results[at.call];
		const fold = result?.ok ? (result.folds[at.block] ?? null) : null;
		const request = calls[at.call];
		const sentences = request?.blocks[at.block]?.sentences ?? [];
		run.items.push({ item: item.id, call: at.call, fold, checks: fold ? checksOf(sentences, fold, request?.translateTo, item.names) : null });
	}
	await writeJson(path.join(resultsDir, label, `r${repeat}.json`), run);
	const answered = run.calls.filter((call) => call.ok);
	const blocks = answered.reduce((sum, call) => sum + call.blocks, 0);
	const per = (field: 'promptTokens' | 'completionTokens') => (answered.reduce((sum, call) => sum + call[field], 0) / blocks).toFixed(0);
	console.log(
		`${label} r${repeat}: ${answered.length} of ${run.calls.length} calls answered, $${run.calls.reduce((sum, call) => sum + call.cost, 0).toFixed(5)}, ` +
			`${per('promptTokens')} input and ${per('completionTokens')} output tokens per paragraph`,
	);
}
