import { canFold, foldsWithOwnKey, parseAccount } from '../account.ts';
import { cacheKey, readCache, writeCache } from '../fold/cache.ts';
import { promptVersion, type FoldRequest } from '../fold/prompt.ts';
import { foldWith, parseSettings, routeOf, type Attempt, type Provider } from '../fold/providers/index.ts';
import { checkKey, type KeyVerdict } from '../fold/providers/openai-compatible.ts';
import type { ProviderId } from '../fold/providers/presets.ts';
import type { Fold } from '../fold/types.ts';
import { readerLanguageKey } from '../i18n.ts';
import { hasFoldedKey, keyCheckTimeoutMs, scriptAnswers, type Ask, type FoldReply, type Replies } from '../messages.ts';
import { claimHint, pageState, setAccount, setScrollModifier, setShortcuts, setSite, tellTabs } from './settings.ts';

void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void chrome.action.setBadgeBackgroundColor({ color: '#2A2A2E' });
void chrome.action.setBadgeTextColor({ color: '#FFFFFF' });

const outcome = ({ provider, result, ms }: Attempt) => `${provider.id} ${result.ok ? 'answered' : `${result.error}, ${result.detail}`}, ${ms} ms`;

async function startIn(tabId: number, js: string[], css: string[]): Promise<void> {
	const target = { tabId };
	if (css.length > 0) await chrome.scripting.insertCSS({ target, files: css });
	await chrome.scripting.executeScript({ target, files: js });
}

type Start = 'live' | 'started' | 'refused';

async function startIfMissing(tabId: number, js: string[], css: string[]): Promise<Start> {
	if (await scriptAnswers(tabId)) return 'live';
	return startIn(tabId, js, css).then(
		(): Start => 'started',
		(): Start => 'refused',
	);
}

// Chrome starts content scripts only in pages that load after tfold is installed, updated or turned back on, and this
// worker starts each of those times. A tab whose copy of the script answers a ping keeps it, a discarded tab gets one
// from the manifest when it loads again, and a tab that Chrome keeps extensions out of, such as the Web Store, refuses.
async function startInOpenTabs(): Promise<void> {
	const began = performance.now();
	const runs: Promise<Start>[] = [];
	for (const { matches = [], js = [], css = [] } of chrome.runtime.getManifest().content_scripts ?? []) {
		for (const { id } of await chrome.tabs.query({ url: matches, discarded: false })) if (id !== undefined) runs.push(startIfMissing(id, js, css));
	}
	const outcomes = await Promise.all(runs);
	const count = (outcome: Start) => outcomes.filter((each) => each === outcome).length;
	const ms = Math.round(performance.now() - began);
	console.log(`content script started in ${count('started')} of ${runs.length - count('live')} open tabs without one, ${ms} ms`);
}

void startInOpenTabs();

const refusedKey = 'refusedProviders';
// All of what was asked with, so a change to the key, the address or the model asks again.
const askedWith = ({ baseUrl, apiKey, model }: Provider) => JSON.stringify([baseUrl, apiKey, model]);

// Kept for the browser session, so a worker that stopped and started again does not ask with the same key again.
async function refusedProviders(): Promise<Partial<Record<ProviderId, string>>> {
	return (await chrome.storage.session.get(refusedKey))[refusedKey] ?? {};
}

async function noteRefused(attempts: readonly Attempt[]): Promise<void> {
	const refused = attempts.filter(({ result }) => !result.ok && result.error === 'refused');
	if (refused.length === 0) return;
	const known = await refusedProviders();
	for (const { provider } of refused) known[provider.id] = askedWith(provider);
	await chrome.storage.session.set({ [refusedKey]: known });
}

async function forgetRefused(id: ProviderId): Promise<void> {
	const known = await refusedProviders();
	delete known[id];
	await chrome.storage.session.set({ [refusedKey]: known });
}

async function fold(request: FoldRequest): Promise<FoldReply> {
	const blocks = request.blocks.length;
	console.log(`fold received, ${blocks} blocks`);
	const stored = await chrome.storage.local.get(['account', 'providers', 'provider']);
	const account = parseAccount(stored.account);
	if (!canFold(account)) {
		console.log(`fold refused, this account cannot fold, ${blocks} blocks`);
		return { ok: false, error: 'failed' };
	}
	// Pro has no key to ask with, even an old one still in storage, and no server to ask yet.
	if (!foldsWithOwnKey(account)) {
		console.log(`fold skipped, quick summaries only, ${blocks} blocks`);
		return { ok: false, error: 'quick-only' };
	}
	const route = routeOf(parseSettings(stored));
	if (!route) {
		console.log(`fold skipped, no API key, ${blocks} blocks`);
		return { ok: false, error: 'no-key' };
	}
	const keysFor = ({ id, baseUrl, model }: Provider) =>
		Promise.all(
			request.blocks.map((block) =>
				cacheKey({ url: request.url, sentences: block.sentences, provider: id, baseUrl, model, promptVersion, translateTo: request.translateTo }),
			),
		);
	const keys = await keysFor(route.first);
	const folds = await Promise.all(keys.map(readCache));
	const missing = request.blocks.filter((_, i) => !folds[i]);
	if (missing.length === 0) {
		console.log(`fold cache hit, ${blocks} blocks`);
		return { ok: true, folds: folds as Fold[] };
	}
	const refused = await refusedProviders();
	const wasRefused = (provider: Provider) => refused[provider.id] === askedWith(provider);
	if (wasRefused(route.first)) {
		console.log(`fold skipped, this key was refused, ${blocks} blocks`);
		return { ok: false, error: 'refused' };
	}
	console.log(`fold request to ${new URL(route.first.baseUrl).host}, ${route.first.model}, ${missing.length} blocks, ${blocks - missing.length} cached`);
	const attempts = await foldWith(route.fallback && wasRefused(route.fallback) ? { ...route, fallback: undefined } : route, { ...request, blocks: missing });
	await noteRefused(attempts);
	const [first, second] = attempts;
	if (second) console.log(`fold fallback to ${second.provider.id} after ${outcome(first)}`);
	if (second && !second.result.ok) console.log(`fold fallback failed, ${outcome(second)}`);
	const { provider, result, ms } = second?.result.ok ? second : first;
	if (!result.ok) {
		console.log(`fold failed, ${result.error}, ${result.detail}, ${ms} ms`);
		return { ok: false, error: result.error };
	}
	console.log(`fold usage ${JSON.stringify({ provider: provider.id, ...result.usage, blocks: missing.length, ms })}`);
	const writeKeys = provider === route.first ? keys : await keysFor(provider);
	const answered = [...result.folds];
	const writes: Promise<void>[] = [];
	for (const [i, key] of writeKeys.entries()) {
		if (folds[i]) continue;
		const fold = answered.shift() as Fold;
		folds[i] = fold;
		writes.push(writeCache(key, fold));
	}
	await Promise.all(writes);
	return { ok: true, folds: folds as Fold[] };
}

async function checkTypedKey(id: ProviderId, apiKey: string): Promise<KeyVerdict> {
	const provider = parseSettings(await chrome.storage.local.get(['providers', 'provider'])).providers[id];
	const started = performance.now();
	const { verdict, detail } = await checkKey({ ...provider, apiKey }, AbortSignal.timeout(keyCheckTimeoutMs));
	console.log(`key check ${id}, ${verdict}, ${detail}, ${Math.round(performance.now() - started)} ms`);
	if (verdict === 'works') await forgetRefused(id);
	return verdict;
}

const fromPages = (sender: chrome.runtime.MessageSender, ...pages: string[]) =>
	pages.some((page) => sender.url?.startsWith(chrome.runtime.getURL(page)) === true);

const handlers: { [K in Ask['type']]: (ask: Extract<Ask, { type: K }>, sender: chrome.runtime.MessageSender) => Promise<Replies[K]> } = {
	fold: ({ request }) =>
		fold(request).catch((error: unknown): FoldReply => {
			console.log(`fold failed, ${String(error)}`);
			return { ok: false, error: 'failed' };
		}),
	page: (_, sender) => pageState(sender),
	'claim-hint': () => claimHint(),
	'note-fold': () => chrome.storage.local.set({ [hasFoldedKey]: true }).then(() => true),
	'set-site': ({ host, on }, sender) => (fromPages(sender, 'options/', 'popup/') ? setSite(host, on) : Promise.resolve(false)),
	'set-shortcuts': ({ shortcuts }, sender) => (fromPages(sender, 'options/') ? setShortcuts(shortcuts) : Promise.resolve(false)),
	'set-scroll-modifier': ({ modifier }, sender) => (fromPages(sender, 'options/') ? setScrollModifier(modifier) : Promise.resolve(false)),
	'set-account': ({ account }, sender) => (TFOLD_DEV && fromPages(sender, 'options/') ? setAccount(account) : Promise.resolve(false)),
	'check-key': ({ provider, apiKey }, sender) => (fromPages(sender, 'options/') ? checkTypedKey(provider, apiKey) : Promise.resolve('unknown')),
};

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'local' && 'account' in changes) void tellTabs({ type: 'account' });
	if (area === 'sync' && readerLanguageKey in changes) void tellTabs({ type: 'language' });
});

chrome.runtime.onMessage.addListener((message: Ask, sender, sendResponse: (reply: unknown) => void) => {
	if (sender.id !== chrome.runtime.id || !Object.hasOwn(handlers, message.type)) return false;
	const handle = handlers[message.type] as (ask: Ask, sender: chrome.runtime.MessageSender) => Promise<unknown>;
	handle(message, sender).then(sendResponse, (error: unknown) => {
		console.log(`${message.type} failed, ${String(error)}`);
		sendResponse(undefined);
	});
	return true;
});

console.log('background ready');
