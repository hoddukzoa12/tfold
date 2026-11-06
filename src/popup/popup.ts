import { canFold, foldsWithOwnKey, parseAccount, type SignedIn } from '../account.ts';
import { chosenId, parseSettings, routeOf } from '../fold/providers/index.ts';
import { presets } from '../fold/providers/presets.ts';
import { followReaderLanguage, localize, showKeys, t } from '../i18n.ts';
import { ask, hasFoldedKey, keyFieldFragment, scriptAnswers } from '../messages.ts';
import { defaultShortcuts, heldName, label, onMac, parseScrollModifier, parseShortcuts, scrollLabel } from '../shortcuts.ts';
import { hostOf, parseSites } from '../sites.ts';
import { storeAccount } from './store-account.ts';

const storedKeys = ['account', 'disabledSites', 'providers', 'provider', 'shortcuts', 'scrollModifier', 'hintSeen', hasFoldedKey];
const silenceGapMs = 50;
const firstPaintWaitMs = 100;

const store = TFOLD_EDITION === 'store' ? storeAccount() : undefined;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const view = byId('view');
const site = byId<HTMLButtonElement>('site');
const siteHost = byId('site-host');
const siteError = byId('site-error');
const providerTitle = byId('provider-title');
const providerState = byId('provider-state');
const providerRow = byId('provider-row');
const addKey = byId<HTMLButtonElement>('add-key');
const howTo = byId('how-to');
const howTitle = byId('how-title');
const scrollWays = [...document.querySelectorAll<HTMLElement>('.way-scroll')];
const foldKeys = byId('fold-keys');
const unfoldKeys = byId('unfold-keys');
const scrollKeys = byId('scroll-keys');

type SiteState = 'on' | 'off' | 'not-a-site';

function showFoldSource(account: SignedIn, stored: Record<string, unknown>, site: SiteState): void {
	const settings = parseSettings(stored);
	const name = presets[chosenId(settings)].name;
	const keyed = foldsWithOwnKey(account) && routeOf(settings) !== undefined;
	const [title, state] = store?.foldSource(account) ?? (keyed ? [t('popupProvider', name), t('popupKeySaved')] : [t('popupNoKeyTitle'), t('popupNoKeyBody', name)]);
	providerTitle.textContent = site === 'on' ? title : t(site === 'off' ? 'popupSiteOff' : 'popupPageOff');
	providerState.textContent = state;
	providerState.hidden = state === '' || site !== 'on';
	addKey.hidden = !foldsWithOwnKey(account) || keyed || site !== 'on';
	addKey.className = stored[hasFoldedKey] === true ? 'button primary' : 'text-button';
}

function showHowTo(on: boolean, stored: Record<string, unknown>): void {
	howTo.hidden = !on;
	howTo.classList.toggle('brief', stored.hintSeen === true);
	if (stored[hasFoldedKey] === true) providerRow.after(howTo);
	else providerRow.before(howTo);
}

function render(host: string | undefined, stored: Record<string, unknown>): void {
	localize();
	const account = parseAccount(stored.account);
	view.hidden = !canFold(account);
	store?.show(account);
	if (!canFold(account)) return;

	const on = host !== undefined && !parseSites(stored.disabledSites).includes(host);
	site.disabled = host === undefined;
	site.setAttribute('aria-checked', String(on));
	siteHost.textContent = host ?? t('popupNoSite');
	siteHost.title = host ?? '';
	siteError.textContent = t('popupSiteFailed');

	showFoldSource(account, stored, host === undefined ? 'not-a-site' : on ? 'on' : 'off');
	showHowTo(on, stored);

	const shortcuts = parseShortcuts(stored.shortcuts) ?? defaultShortcuts;
	showKeys(foldKeys, label(shortcuts.fold, onMac));
	showKeys(unfoldKeys, label(shortcuts.unfold, onMac));
	const scrollModifier = parseScrollModifier(stored.scrollModifier);
	for (const way of scrollWays) way.hidden = scrollModifier === 'off';
	howTitle.textContent = scrollModifier === 'off' ? t('popupHowKeys') : t('popupHow', heldName(scrollModifier, onMac));
	if (scrollModifier !== 'off') showKeys(scrollKeys, scrollLabel(scrollModifier, onMac, t('scrollWord'), '↓ ↑'));
}

// chrome.runtime.openOptionsPage only reuses a settings tab in this window, and opens a second one beside a tab open in
// another. A fragment on an open tab stays in the same document, so what the reader typed there is kept.
async function openSettings(windowId: number | undefined, fragment = ''): Promise<void> {
	const settingsUrl = chrome.runtime.getURL('options/options.html');
	const open = await chrome.tabs.query({ url: `${settingsUrl}*` });
	const target = open.find((tab) => tab.windowId === windowId) ?? open[0];
	if (target?.id !== undefined) {
		await chrome.tabs.update(target.id, { active: true, ...(fragment === '' ? {} : { url: settingsUrl + fragment }) });
		await chrome.windows.update(target.windowId, { focused: true });
	} else {
		await chrome.tabs.create({ url: settingsUrl + fragment });
	}
	close();
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Chrome keeps content scripts out of some web pages, such as the Web Store, and nothing folds there. A page
// still loading has no script yet, and a busy page answers late, so only silence twice over after it has loaded counts.
async function staysSilent(tabId: number): Promise<boolean> {
	for (let silences = 0; ; await wait(silenceGapMs)) {
		if (await scriptAnswers(tabId)) return false;
		const { status } = await chrome.tabs.get(tabId);
		silences = status === 'complete' ? silences + 1 : 0;
		if (silences === 2) return true;
	}
}

async function start(): Promise<void> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	let host = hostOf(tab?.url);
	const windowId = tab?.windowId;
	const paint = async () => {
		const stored = await chrome.storage.local.get(storedKeys);
		render(host, stored);
	};
	const silent = (host === undefined || tab?.id === undefined ? Promise.resolve(false) : staysSilent(tab.id).catch(() => false)).then((yes) => {
		if (yes) host = undefined;
		return yes;
	});
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && storedKeys.some((key) => key in changes)) void paint();
	});
	site.addEventListener('click', () => {
		if (host === undefined) return;
		const on = site.getAttribute('aria-checked') !== 'true';
		site.setAttribute('aria-checked', String(on));
		siteError.hidden = true;
		void ask({ type: 'set-site', host, on }).then((saved) => {
			if (saved === true) return;
			site.setAttribute('aria-checked', String(!on));
			siteError.hidden = false;
		});
	});
	addKey.addEventListener('click', () => void openSettings(windowId, keyFieldFragment));
	byId('settings').addEventListener('click', (event) => {
		event.preventDefault();
		void openSettings(windowId);
	});
	store?.listen((fragment) => openSettings(windowId, fragment));
	await Promise.race([silent, wait(firstPaintWaitMs)]);
	await followReaderLanguage(paint);
	performance.mark('tfold-ready');
	if (await silent) await paint();
}

void start();
