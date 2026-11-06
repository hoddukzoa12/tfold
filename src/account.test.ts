import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { expect, test } from 'vitest';
import { canFold, foldsWithOwnKey, parseAccount, trialDaysLeft } from './account.ts';
import { enStore } from './strings/en.ts';
import { koStore } from './strings/ko.ts';

const usage = { remainingPercent: 72, resetsAt: '2026-12-01T00:00:00Z' };

test('a new install, or anything stored that is not an account, reads as signed out and cannot fold', () => {
	for (const raw of [undefined, null, 'free', {}, { kind: 'admin' }, { kind: 'signedOut' }, { kind: 'pro' }, { kind: 'pro', remainingPercent: 50 }]) {
		expect(parseAccount(raw), JSON.stringify(raw)).toEqual({ kind: 'signedOut' });
	}
	expect(canFold(parseAccount(undefined))).toBe(false);
});

test('free and pro accounts can fold, and a pro account keeps a real trial end and a whole remaining percent from 0 to 100', () => {
	expect(parseAccount({ kind: 'free', trialEndsAt: '2026-11-11T12:00:00Z' })).toEqual({ kind: 'free' });
	expect(parseAccount({ kind: 'pro', trialEndsAt: '2026-11-11T12:00:00Z', ...usage })).toEqual({ kind: 'pro', trialEndsAt: '2026-11-11T12:00:00Z', ...usage });
	expect(parseAccount({ kind: 'pro', trialEndsAt: 'next week', ...usage })).toEqual({ kind: 'pro', ...usage });
	expect([72.9, 0.4, -3, 140].map((remainingPercent) => parseAccount({ kind: 'pro', ...usage, remainingPercent }))).toEqual(
		[72, 0, 0, 100].map((remainingPercent) => ({ kind: 'pro', ...usage, remainingPercent })),
	);
	expect([parseAccount({ kind: 'free' }), parseAccount({ kind: 'pro', ...usage })].map(canFold)).toEqual([true, true]);
});

test('signed out and free readers fold with their own key, and pro readers fold with the plan', () => {
	expect([parseAccount(undefined), parseAccount({ kind: 'free' }), parseAccount({ kind: 'pro', ...usage })].map(foldsWithOwnKey)).toEqual([true, true, false]);
});

test('in the open edition anything stored reads as Free, which folds with its own key', async () => {
	const { outputFiles } = await build({
		entryPoints: [path.join(import.meta.dirname, 'account.ts')],
		bundle: true,
		format: 'cjs',
		write: false,
		define: { TFOLD_EDITION: '"open"' },
	});
	const module: { exports: Partial<typeof import('./account.ts')> } = { exports: {} };
	runInNewContext(outputFiles[0]?.text ?? '', { module, exports: module.exports });
	const open = module.exports as typeof import('./account.ts');
	for (const raw of [undefined, null, 'free', {}, { kind: 'signedOut' }, { kind: 'free' }, { kind: 'pro', ...usage }]) {
		const account = open.parseAccount(raw);
		expect(account.kind, JSON.stringify(raw)).toBe('free');
		expect([open.canFold(account), open.foldsWithOwnKey(account)], JSON.stringify(raw)).toEqual([true, true]);
	}
});

const at = (day: number, hour: number, minute = 0, ms = 0) => new Date(2026, 10, day, hour, minute, 0, ms);
const trialLine = (end: Date, now: Date) => {
	const days = trialDaysLeft(end.toISOString(), now.getTime());
	return days === undefined ? null : { en: enStore.trialLeft(days), ko: koStore.trialLeft(days) };
};
const today = { en: 'Trial ends today', ko: '체험이 오늘 끝나요' };
const tomorrow = { en: 'Trial ends tomorrow', ko: '체험이 내일 끝나요' };
const inDays = (days: number) => ({ en: `${days} days left in trial`, ko: `체험 ${days}일 남음` });

test.each([
	['an ended trial shows no line', at(4, 9, 59), at(4, 10), null],
	['a trial ending this instant shows no line', at(4, 10), at(4, 10), null],
	['a minute left ends today', at(4, 10, 1), at(4, 10), today],
	['an end just before midnight is today', at(4, 23, 59, 999), at(4, 10), today],
	['an end at midnight tonight still lasts through today', at(5, 0), at(4, 10), today],
	['an end a moment after midnight is tomorrow', at(5, 0, 0, 1), at(4, 10), tomorrow],
	['25 hours left in the morning ends tomorrow', at(5, 11), at(4, 10), tomorrow],
	['47 hours left at 1 am ends tomorrow', at(5, 23, 59), at(4, 1, 0), tomorrow],
	['25 hours left at 11 pm ends the day after tomorrow at midnight, so it lasts through tomorrow', at(6, 0), at(4, 23), tomorrow],
	['an end at 00:30 the day after tomorrow is 2 days away', at(6, 0, 30), at(4, 23), inDays(2)],
	['26 hours left at 11 pm is 2 days away', at(6, 1), at(4, 23), inDays(2)],
	['4 days at noon is 4 days away', at(8, 12), at(4, 12), inDays(4)],
	['a 7-day trial started today is 7 days away', at(11, 9), at(4, 9), inDays(7)],
])('trial line: %s', (_, end, now, expected) => {
	expect(trialLine(end, now)).toEqual(expected);
});
