export type Account =
	| { kind: 'signedOut' }
	| { kind: 'free' }
	| { kind: 'pro'; trialEndsAt?: string; remainingPercent: number; resetsAt: string };

export type SignedIn = Exclude<Account, { kind: 'signedOut' }>;

const signedOut: Account = { kind: 'signedOut' };

const isDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

function parseStoredAccount(raw: unknown): Account {
	if (typeof raw !== 'object' || raw === null) return signedOut;
	const { kind, trialEndsAt, remainingPercent, resetsAt } = raw as Record<string, unknown>;
	if (kind === 'free') return { kind };
	if (kind !== 'pro' || typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent) || !isDate(resetsAt)) return signedOut;
	const percent = Math.min(100, Math.max(0, Math.floor(remainingPercent)));
	return { kind, ...(isDate(trialEndsAt) ? { trialEndsAt } : {}), remainingPercent: percent, resetsAt };
}

const dayMs = 86_400_000;
const startOfDay = (time: number) => {
	const date = new Date(time);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

// 0 is today and 1 is tomorrow in the reader's time zone. A trial that ends at midnight lasts through the day before.
export function trialDaysLeft(trialEndsAt: string, now: number): number | undefined {
	const end = Date.parse(trialEndsAt);
	if (end <= now) return undefined;
	return Math.round((startOfDay(end - 1) - startOfDay(now)) / dayMs);
}

// The open edition has no accounts. A reader is Free whatever an earlier development build left in storage.
export const parseAccount = (raw: unknown): Account => (TFOLD_EDITION === 'open' ? { kind: 'free' } : parseStoredAccount(raw));

export const canFold = (account: Account): account is SignedIn => TFOLD_EDITION === 'open' || account.kind !== 'signedOut';

export const foldsWithOwnKey = (account: Account): boolean => TFOLD_EDITION === 'open' || account.kind !== 'pro';

export const signInUrl = 'https://tfold.xyz/signin';
