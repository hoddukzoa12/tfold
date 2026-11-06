import { canFold, parseAccount, type Account } from '../account.ts';
import { languageOf, readReaderLanguage, stringsIn } from '../i18n.ts';
import type { PageState, Tell } from '../messages.ts';
import { defaultShortcuts, parseScrollModifier, parseShortcuts, type ScrollModifier, type Shortcuts } from '../shortcuts.ts';
import { hostOf, parseSites } from '../sites.ts';
import type { Strings } from '../strings/en.ts';

type Settings = { account: Account; disabledSites: string[]; hintSeen: boolean; shortcuts: Shortcuts; scrollModifier: ScrollModifier };

let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(change: () => Promise<T>): Promise<T> {
	const next = queue.then(change);
	queue = next.catch(() => undefined);
	return next;
}

async function settings(): Promise<Settings> {
	const { account, disabledSites, hintSeen, shortcuts, scrollModifier } = await chrome.storage.local.get(['account', 'disabledSites', 'hintSeen', 'shortcuts', 'scrollModifier']);
	return {
		account: parseAccount(account),
		disabledSites: parseSites(disabledSites),
		hintSeen: hintSeen === true,
		shortcuts: parseShortcuts(shortcuts) ?? defaultShortcuts,
		scrollModifier: parseScrollModifier(scrollModifier),
	};
}

async function writeSite(host: string, on: boolean): Promise<void> {
	const sites = new Set((await settings()).disabledSites);
	if (on) sites.delete(host);
	else sites.add(host);
	await chrome.storage.local.set({ disabledSites: [...sites].sort() });
}

function showState(tabId: number, text: Strings, host: string, account: Account, siteOn: boolean): void {
	void chrome.action.setBadgeText({ tabId, text: canFold(account) && !siteOn ? text.badgeOff : '' });
	void chrome.action.setTitle({ tabId, title: TFOLD_EDITION === 'store' && !canFold(account) ? text.actionSignedOut : (siteOn ? text.actionOn : text.actionOff)(host) });
}

export async function pageState(sender: chrome.runtime.MessageSender): Promise<PageState> {
	const host = hostOf(sender.url);
	const [{ account, disabledSites, hintSeen, shortcuts, scrollModifier }, setting] = await Promise.all([settings(), readReaderLanguage()]);
	const siteOn = host === undefined || !disabledSites.includes(host);
	if (host !== undefined && sender.tab?.id !== undefined) showState(sender.tab.id, stringsIn(languageOf(setting)), host, account, siteOn);
	const on = canFold(account) && siteOn;
	return { on, hint: on && !hintSeen, shortcuts, scrollModifier };
}

export async function tellTabs(message: Tell): Promise<void> {
	const tabs = await chrome.tabs.query({});
	await Promise.all(tabs.flatMap((tab) => (tab.id === undefined ? [] : [chrome.tabs.sendMessage(tab.id, message).catch(() => undefined)])));
}

export async function setSite(host: string, on: boolean): Promise<boolean> {
	await serialized(() => writeSite(host, on));
	await tellTabs({ type: 'site', host });
	return true;
}

export async function setShortcuts(raw: unknown): Promise<boolean> {
	const shortcuts = parseShortcuts(raw);
	if (!shortcuts) return false;
	await serialized(() => chrome.storage.local.set({ shortcuts }));
	await tellTabs({ type: 'shortcuts' });
	return true;
}

export async function setScrollModifier(raw: unknown): Promise<boolean> {
	await serialized(() => chrome.storage.local.set({ scrollModifier: parseScrollModifier(raw) }));
	await tellTabs({ type: 'shortcuts' });
	return true;
}

export async function setAccount(account: Account): Promise<boolean> {
	await serialized(() => chrome.storage.local.set({ account: parseAccount(account) }));
	return true;
}

export function claimHint(): Promise<boolean> {
	return serialized(async () => {
		if ((await settings()).hintSeen) return false;
		await chrome.storage.local.set({ hintSeen: true });
		return true;
	});
}
