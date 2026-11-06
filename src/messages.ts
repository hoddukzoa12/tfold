import type { Account } from './account.ts';
import type { FoldRequest } from './fold/prompt.ts';
import type { FoldError } from './fold/providers/index.ts';
import type { KeyVerdict } from './fold/providers/openai-compatible.ts';
import type { ProviderId } from './fold/providers/presets.ts';
import type { Fold } from './fold/types.ts';
import type { ScrollModifier, Shortcuts } from './shortcuts.ts';

export type FoldReply = { ok: true; folds: Fold[] } | { ok: false; error: FoldError };
export type PageState = { on: boolean; hint: boolean; shortcuts: Shortcuts; scrollModifier: ScrollModifier };

export type Ask =
	| { type: 'fold'; request: FoldRequest }
	| { type: 'page' }
	| { type: 'claim-hint' }
	| { type: 'note-fold' }
	| { type: 'set-site'; host: string; on: boolean }
	| { type: 'set-shortcuts'; shortcuts: Shortcuts }
	| { type: 'set-scroll-modifier'; modifier: ScrollModifier }
	| { type: 'set-account'; account: Account }
	| { type: 'check-key'; provider: ProviderId; apiKey: string };

export type Replies = {
	fold: FoldReply;
	page: PageState;
	'claim-hint': boolean;
	'note-fold': boolean;
	'set-site': boolean;
	'set-shortcuts': boolean;
	'set-scroll-modifier': boolean;
	'set-account': boolean;
	'check-key': KeyVerdict;
};

export type Tell = { type: 'site'; host: string } | { type: 'shortcuts' } | { type: 'account' } | { type: 'language' } | { type: 'ping' };

// Chrome stops an extension service worker whose fetch waits more than 30 s, so the deadline has to come first.
export const requestTimeoutMs = 12_000;
export const replyDeadlineMs = requestTimeoutMs + 1_000;
// A reader who sees a failure's badge and tries again takes about this long, and a held arrow, which presses about 30 times a
// second, then asks for a paragraph once in this long.
export const failedWaitMs = 2_000;
export const keyCheckTimeoutMs = 8_000;
export const hasFoldedKey = 'hasFolded';

// The popup opens settings at one of these fragments to ask for the key field or the sample, and settings clears it once it has answered.
export const keyFieldFragment = '#key-field';
export const sampleFragment = '#sample';

// Answered by the listener of a tab's live content script. Chrome rejects it at once when the tab has none.
export const scriptAnswers = (tabId: number): Promise<boolean> =>
	chrome.tabs.sendMessage(tabId, { type: 'ping' } satisfies Tell, { frameId: 0 }).then(
		() => true,
		() => false,
	);

export async function ask<T extends Ask>(message: T): Promise<Replies[T['type']] | undefined> {
	try {
		return await chrome.runtime.sendMessage<T, Replies[T['type']]>(message);
	} catch {
		return undefined;
	}
}
