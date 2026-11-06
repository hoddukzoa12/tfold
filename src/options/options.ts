import { parseAccount, type Account } from '../account.ts';
import { chosenId, parseSettings, routeOf, storedSettings, wellFormedModel, type ProviderSettings } from '../fold/providers/index.ts';
import { wellFormedKey, type KeyVerdict } from '../fold/providers/openai-compatible.ts';
import { presets, providerIds, type ProviderId } from '../fold/providers/presets.ts';
import { followReaderLanguage, localize, parseReaderLanguage, readerLanguageKey, showKeys, t, type ReaderLanguage, type TextKey } from '../i18n.ts';
import { ask, keyFieldFragment, sampleFragment } from '../messages.ts';
import {
	comboOf,
	defaultScrollModifier,
	defaultShortcuts,
	heldName,
	isModifierCode,
	label,
	onMac,
	parseScrollModifier,
	parseShortcuts,
	problemWith,
	sameCombo,
	type Combo,
	type Problem,
	type ScrollModifier,
	type Shortcuts,
} from '../shortcuts.ts';
import { parseSites } from '../sites.ts';
import { autoTranslateKey, parseAutoTranslate } from '../translation.ts';
import { useScrollModifier, useShortcuts } from '../content/gesture.ts';
import { maxRun } from '../content/hold-model.ts';
import { mountDevAccount } from './dev-account.ts';
import { paintSample, startSample } from './sample.ts';
import { storeAccount, type AccountPage } from './store-account.ts';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = byId<HTMLFormElement>('provider');
const providerSection = byId('provider-section');
const route = byId('route');
const getKey = byId<HTMLAnchorElement>('get-key');
const keyMoney = byId('key-money');
const useOther = byId<HTMLButtonElement>('use-other');
const backupHint = byId('backup-hint');
const getBackupKey = byId<HTMLAnchorElement>('get-backup-key');
const advanced = byId<HTMLDetailsElement>('advanced');
const modelInput = byId<HTMLInputElement>('model');
const modelHint = byId('model-hint');
const saveButton = byId<HTMLButtonElement>('save');
const status = byId('status');
const undoButton = byId<HTMLButtonElement>('undo');
const sites = byId<HTMLUListElement>('sites');
const noSites = byId('no-sites');
const sitesStatus = byId('sites-status');
const changeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-change]')];
const defaultKeys = byId<HTMLButtonElement>('default-keys');
const keysStatus = byId('keys-status');
if (!onMac) byId('scroll-meta-choice').remove();
const scrollChoices = [...document.querySelectorAll<HTMLInputElement>('input[name="scroll-modifier"]')];
const scrollMeta = document.getElementById('scroll-meta');
const scrollCtrl = byId('scroll-ctrl');
const scrollAlt = byId('scroll-alt');
const scrollHint = byId('scroll-hint');
const waysIntro = byId('ways-intro');
const intro = byId('intro');
const privacy = byId('privacy');
const languageChoices = [...document.querySelectorAll<HTMLInputElement>('input[name="language"]')];
const autoTranslate = byId<HTMLButtonElement>('auto-translate');
const autoTranslateHint = byId('auto-translate-hint');
const autoTranslateReason = byId('auto-translate-reason');
const autoTranslateReasonLink = byId<HTMLAnchorElement>('auto-translate-reason-link');
const sitesSection = byId('sites-section');
const sampleSection = byId('sample-section');
const sampleStage = byId('sample-stage');
const sampleHint = byId('sample-hint');
const sampleNext = byId('sample-next');
const trySample = byId<HTMLAnchorElement>('try-sample');

// The front field holds the key of the service tfold asks first, and the one in Advanced holds the other.
type KeyField = { input: HTMLInputElement; label: HTMLElement; state: HTMLElement; remove: HTMLButtonElement };

const keyField = (id: string, removeId: string): KeyField => ({
	input: byId(id),
	label: byId(`${id}-label`),
	state: byId(`${id}-state`),
	remove: byId(removeId),
});

const front = keyField('key', 'remove-key');
const backup = keyField('backup-key', 'remove-backup-key');
const keyFields = [front, backup];

const nameOf = (id: ProviderId) => presets[id].name;
const otherThan = (id: ProviderId) => providerIds.find((each) => each !== id) ?? id;

type Tone = 'success' | 'error' | 'caution' | 'plain';
type UndoOffer = { id: ProviderId; removed: string };
type Notice = { tone: Tone; text: () => string; undo?: UndoOffer; trySample?: boolean };

const notices = new Map<HTMLElement, Notice | undefined>();

function paintNotice(line: HTMLElement): void {
	const notice = notices.get(line);
	line.textContent = notice?.text() ?? '';
	if (notice) line.dataset.tone = notice.tone;
	else delete line.dataset.tone;
	if (line !== status) return;
	undoButton.hidden = notice?.undo === undefined;
	undoButton.textContent = t('undo');
	trySample.hidden = notice?.trySample !== true;
}

const undoWindowMs = 8_000;
let undoTimer: ReturnType<typeof setTimeout> | undefined;

function tell(line: HTMLElement, notice?: Notice): void {
	if (line === status) clearTimeout(undoTimer);
	notices.set(line, notice);
	paintNotice(line);
}

const verdictOutcomes: Record<KeyVerdict, { tone: Tone; saved: boolean; text: (name: string) => string }> = {
	works: { tone: 'success', saved: true, text: (name) => t('keyWorks', name) },
	unknown: { tone: 'caution', saved: true, text: (name) => t('keyUnknown', name) },
	refused: { tone: 'error', saved: false, text: (name) => t('keyRefused', name) },
	malformed: { tone: 'error', saved: false, text: (name) => t('keyMalformed', name) },
};

const worstFirst: Tone[] = ['error', 'caution', 'success'];

let account: Account = parseAccount(undefined);
let shown: ProviderSettings | undefined;
let disabledSites: string[] = [];
let saving = false;
let translateOn = false;
let sampleFolded = false;

const inFront = () => (shown ? chosenId(shown) : providerIds[0]);
const heldBy = (field: KeyField) => (field === front ? inFront() : otherThan(inFront()));
const fieldOf = (id: ProviderId) => (id === inFront() ? front : backup);

async function stored(): Promise<ProviderSettings> {
	return parseSettings(await chrome.storage.local.get(['providers', 'provider']));
}

function routeText(settings: ProviderSettings): string {
	const plan = routeOf(settings);
	if (plan) return plan.fallback ? t('routeBoth', nameOf(plan.first.id), nameOf(plan.fallback.id)) : t('routeOne', nameOf(plan.first.id));
	const id = chosenId(settings);
	const other = otherThan(id);
	return settings.providers[other].apiKey === '' ? t('routeNoKey') : t('routeNoKeyOther', nameOf(id), nameOf(other));
}

function describe(settings: ProviderSettings): void {
	const id = chosenId(settings);
	const other = otherThan(id);
	const saved = settings.providers[id].apiKey !== '';
	const backupSaved = settings.providers[other].apiKey !== '';
	const sentence = routeText(settings);
	if (route.textContent !== sentence) route.textContent = sentence;
	getKey.hidden = saved;
	getKey.textContent = t('getKey', nameOf(id));
	getKey.href = presets[id].keysPage;
	front.label.textContent = t('keyLabel', nameOf(id));
	front.state.textContent = saved ? t('keySaved') : t('keyAccount', nameOf(id));
	front.remove.hidden = !saved;
	front.remove.textContent = t('removeKey', nameOf(id));
	keyMoney.textContent = t('keyMoney', nameOf(id));
	useOther.textContent = t('useInstead', nameOf(other));
	backup.label.textContent = t('backupKeyLabel', nameOf(other));
	backup.state.textContent = backupSaved ? t('keySaved') : '';
	backup.remove.hidden = !backupSaved;
	backup.remove.textContent = t('removeKey', nameOf(other));
	backupHint.textContent = t(saved ? 'backupHint' : 'backupHintNoFirst', nameOf(id), nameOf(other));
	getBackupKey.hidden = backupSaved;
	getBackupKey.textContent = t('getKey', nameOf(other));
	getBackupKey.href = presets[other].keysPage;
	modelHint.textContent = t('modelHint', nameOf(id), presets[id].model);
}

const ownKeyPage: AccountPage = {
	intro: () => t('settingsIntro'),
	privacy: () => t('privacy'),
	sampleNext: 'sampleNext',
	keys: true,
	sites: true,
	aiLock: (keyed) => (keyed ? undefined : { reason: 'autoTranslateNeedsKey', open: focusKeyField }),
};

const store = TFOLD_EDITION === 'store' ? storeAccount(ownKeyPage) : undefined;
const accountPage = () => store?.pageOf(account) ?? ownKeyPage;
const aiLock = () => accountPage().aiLock(shown !== undefined && routeOf(shown) !== undefined);
const sampleWithAi = () => aiLock() === undefined;

function show(settings: ProviderSettings): void {
	// A key being typed belongs to its service, so when the services trade fields it goes along.
	if (shown && chosenId(shown) !== chosenId(settings)) [front.input.value, backup.input.value] = [backup.input.value, front.input.value];
	shown = settings;
	const id = chosenId(settings);
	describe(settings);
	paintSample(sampleWithAi());
	modelInput.value = settings.providers[id].model;
	if (settings.providers[otherThan(id)].apiKey !== '' || backup.input.value.trim() !== '' || settings.providers[id].model !== presets[id].model) advanced.open = true;
	showAutoTranslate();
	refreshSave();
}

const modelValue = () => modelInput.value.trim();
const modelChanged = () => shown !== undefined && modelValue() !== shown.providers[chosenId(shown)].model;

const typedKeys = () =>
	keyFields.flatMap((field) => {
		const apiKey = field.input.value.trim();
		return apiKey === '' ? [] : [{ id: heldBy(field), apiKey }];
	});

function refreshSave(): void {
	const keyed = typedKeys().length > 0;
	saveButton.disabled = saving || !(keyed || modelChanged());
	saveButton.textContent = t(!keyed && modelChanged() ? 'saveModel' : 'saveKey');
	// Lime marks the next step: getting a key until one is typed, then saving it.
	getKey.classList.toggle('primary', !keyed);
}

// A check takes up to 8 seconds and its save writes last, so nothing else may change the keys until it is done.
function setSaving(on: boolean): void {
	saving = on;
	form.setAttribute('aria-busy', String(on));
	for (const { input } of keyFields) input.readOnly = on;
	modelInput.readOnly = on;
	for (const control of [useOther, front.remove, backup.remove]) control.disabled = on;
	refreshSave();
}

async function write(after: ProviderSettings): Promise<void> {
	await chrome.storage.local.set({ providers: storedSettings(after) });
	await chrome.storage.local.remove('provider');
	show(after);
}

async function save(change: (settings: ProviderSettings) => ProviderSettings): Promise<{ before: ProviderSettings; after: ProviderSettings }> {
	const before = await stored();
	const after = change(before);
	await write(after);
	return { before, after };
}

const withProvider = (settings: ProviderSettings, id: ProviderId, change: { apiKey?: string; model?: string }): ProviderSettings => ({
	...settings,
	providers: { ...settings.providers, [id]: { ...settings.providers[id], ...change } },
});

// The first service stays first through a change to the keys, unless only the other one can still answer. So a key saved
// as the backup does not take over, and after removing the only OpenRouter key the next key pasted still goes to OpenRouter.
function keepFirst(before: ProviderSettings, after: ProviderSettings): ProviderSettings {
	if (chosenId(after) === chosenId(before)) return after;
	const kept = { ...after, chosen: chosenId(before) };
	return routeOf(after) && !routeOf(kept) ? after : kept;
}

useOther.addEventListener('click', () => {
	void stored().then(async (settings) => {
		const id = otherThan(chosenId(settings));
		// Moving now would stop the AI summaries that work today, so the other service gets its key first.
		if (settings.providers[id].apiKey === '' && routeOf(settings)) {
			tell(status, { tone: 'plain', text: () => t('useNeedsKey', nameOf(id)) });
			backup.input.focus();
			return;
		}
		tell(status);
		await write({ ...settings, chosen: id });
	});
});

for (const { input } of keyFields) {
	input.addEventListener('input', () => {
		input.removeAttribute('aria-invalid');
		refreshSave();
	});
}
modelInput.addEventListener('input', () => {
	modelInput.removeAttribute('aria-invalid');
	refreshSave();
});

const verdictOn = async (id: ProviderId, apiKey: string): Promise<KeyVerdict> =>
	wellFormedKey(apiKey) ? ((await ask({ type: 'check-key', provider: id, apiKey })) ?? 'unknown') : 'malformed';

async function submit(id: ProviderId): Promise<void> {
	const typed = typedKeys();
	const model = modelValue();
	const newModel = modelChanged();
	if (newModel && !wellFormedModel(model)) {
		tell(status, { tone: 'error', text: () => t('modelMalformed', presets[id].model) });
		modelInput.setAttribute('aria-invalid', 'true');
		advanced.open = true;
		modelInput.focus();
		return;
	}
	setSaving(true);
	tell(status, typed.length > 0 ? { tone: 'plain', text: () => t('keyChecking') } : undefined);
	const checked = await Promise.all(typed.map(async (key) => ({ ...key, verdict: await verdictOn(key.id, key.apiKey) })));
	const { before, after } = await save((settings) =>
		keepFirst(
			settings,
			checked.reduce((all, { id: each, apiKey, verdict }) => (verdictOutcomes[verdict].saved ? withProvider(all, each, { apiKey }) : all), withProvider(settings, id, { model })),
		),
	);
	setSaving(false);

	const parts = [...checked.map(({ id: each, verdict }) => () => verdictOutcomes[verdict].text(nameOf(each))), ...(newModel ? [() => t('modelSaved')] : [])];
	const tones = checked.map(({ verdict }) => verdictOutcomes[verdict].tone);
	const firstKey = routeOf(before) === undefined && routeOf(after) !== undefined;
	tell(status, { tone: worstFirst.find((tone) => tones.includes(tone)) ?? 'success', text: () => parts.map((part) => part()).join(' '), trySample: firstKey });

	for (const { id: each, verdict } of checked) {
		if (verdictOutcomes[verdict].saved) fieldOf(each).input.value = '';
		else fieldOf(each).input.setAttribute('aria-invalid', 'true');
	}
	refreshSave();
	const unsaved = checked.find(({ verdict }) => !verdictOutcomes[verdict].saved);
	if (unsaved) {
		const { input } = fieldOf(unsaved.id);
		if (input === backup.input) advanced.open = true;
		input.focus();
		input.select();
	} else if (firstKey) {
		trySample.focus();
	}
}

function focusSample(): void {
	sampleSection.scrollIntoView({ block: 'start' });
	sampleStage.focus({ preventScroll: true });
}

trySample.addEventListener('click', (event) => {
	event.preventDefault();
	focusSample();
});

form.addEventListener('submit', (event) => {
	event.preventDefault();
	if (shown && !saving && !saveButton.disabled) void submit(chosenId(shown));
});

// A removal leaves the key empty. Once a key is back in that place, from this tab or another, the offer would overwrite it.
const staleOffer = ({ id }: UndoOffer, settings: ProviderSettings) => settings.providers[id].apiKey !== '';

function endOffer({ id }: UndoOffer): void {
	const hadFocus = document.activeElement === undoButton;
	tell(status);
	if (hadFocus) fieldOf(id).input.focus();
}

async function restore(offer: UndoOffer): Promise<void> {
	const settings = await stored();
	if (staleOffer(offer, settings)) {
		endOffer(offer);
		return;
	}
	await write(withProvider(settings, offer.id, { apiKey: offer.removed }));
	tell(status, { tone: 'success', text: () => t('keyRestored', nameOf(offer.id)) });
	fieldOf(offer.id).remove.focus();
}

function offerUndo(id: ProviderId, removed: string): void {
	const offer = { id, removed };
	tell(status, { tone: 'success', text: () => t('keyRemoved', nameOf(id)), undo: offer });
	undoButton.focus();
	const expire = () => {
		if (undoButton.matches(':hover, :focus')) undoTimer = setTimeout(expire, 1_000);
		else endOffer(offer);
	};
	undoTimer = setTimeout(expire, undoWindowMs);
}

undoButton.addEventListener('click', () => {
	const offer = notices.get(status)?.undo;
	if (offer) void restore(offer);
});

async function followStoredKeys(): Promise<void> {
	const settings = await stored();
	const typedModel = shown && chosenId(shown) === chosenId(settings) && modelChanged() ? modelInput.value : undefined;
	show(settings);
	if (typedModel !== undefined) modelInput.value = typedModel;
	refreshSave();
	const offer = notices.get(status)?.undo;
	if (offer && staleOffer(offer, settings)) endOffer(offer);
}

for (const field of keyFields) {
	field.remove.addEventListener('click', () => {
		const id = heldBy(field);
		void save((settings) => keepFirst(settings, withProvider(settings, id, { apiKey: '' }))).then(({ before }) => {
			field.input.removeAttribute('aria-invalid');
			offerUndo(id, before.providers[id].apiKey);
		});
	});
}

function focusKeyField(): void {
	if (!shown || providerSection.hidden) return;
	providerSection.scrollIntoView({ block: 'start' });
	front.input.focus({ preventScroll: true });
}

const fragmentAnswers: Record<string, () => void> = { [keyFieldFragment]: focusKeyField, [sampleFragment]: focusSample };

function answerFragment(): void {
	const answer = fragmentAnswers[location.hash];
	if (!answer || !shown) return;
	history.replaceState(null, '', location.pathname);
	answer();
}

addEventListener('hashchange', answerFragment);

function showSites(raw: unknown): void {
	disabledSites = parseSites(raw);
	noSites.hidden = disabledSites.length > 0;
	sites.replaceChildren(
		...disabledSites.map((host) => {
			const item = document.createElement('li');
			item.className = 'row';
			const name = document.createElement('span');
			name.textContent = host;
			const turnOn = document.createElement('button');
			turnOn.type = 'button';
			turnOn.className = 'button';
			turnOn.textContent = t('turnOn');
			turnOn.setAttribute('aria-label', t('turnOnFor', host));
			turnOn.addEventListener('click', () => {
				void ask({ type: 'set-site', host, on: true }).then((saved) => tell(sitesStatus, saved === true ? undefined : { tone: 'error', text: () => t('turnOnFailed', host) }));
			});
			item.append(name, turnOn);
			return item;
		}),
	);
}

type Action = keyof Shortcuts;

const actionNames: Record<Action, TextKey> = { fold: 'foldOneLevel', unfold: 'unfoldOneLevel' };

const problems: Record<Problem, (combo: Combo) => string> = {
	modifiers: () => t(onMac ? 'problemModifiersMac' : 'problemModifiers'),
	key: () => t('problemKey'),
	taken: (combo) => t('problemTaken', label(combo, onMac)),
	same: () => t('problemSame'),
};

let shortcuts = defaultShortcuts;
let scrollModifier: ScrollModifier = defaultScrollModifier;
let recording: Action | undefined;
const sampleKey = document.createElement('kbd');
const keyCaps: Record<Action, Element[]> = {
	fold: [...document.querySelectorAll('#shortcuts .fold-keys')],
	unfold: [...document.querySelectorAll('#shortcuts .unfold-keys')],
};

function showShortcuts(next: Shortcuts): void {
	shortcuts = next;
	useShortcuts(next);
	for (const action of ['fold', 'unfold'] as const) {
		for (const kbd of keyCaps[action]) showKeys(kbd, label(next[action], onMac));
	}
	defaultKeys.disabled = sameCombo(next.fold, defaultShortcuts.fold) && sameCombo(next.unfold, defaultShortcuts.unfold);
}

function record(action: Action | undefined): void {
	recording = action;
	for (const button of changeButtons) {
		const own = button.dataset.change as Action;
		const active = own === action;
		button.textContent = t(active ? 'pressNew' : 'change');
		button.setAttribute('aria-label', t(active ? 'pressNewFor' : 'changeFor', t(actionNames[own])));
		button.setAttribute('aria-pressed', String(active));
	}
}

const pressNotice = (): Notice => ({ tone: 'plain', text: () => t('keysPress') });

async function saveShortcuts(next: Shortcuts, text: () => string): Promise<void> {
	const saved = await ask({ type: 'set-shortcuts', shortcuts: next });
	tell(keysStatus, saved ? { tone: 'success', text } : { tone: 'error', text: () => t('keysSaveFailed') });
}

for (const button of changeButtons) {
	button.addEventListener('click', () => {
		record(recording === button.dataset.change ? undefined : (button.dataset.change as Action));
		tell(keysStatus, recording ? pressNotice() : undefined);
	});
}

addEventListener(
	'keydown',
	(event) => {
		const action = recording;
		if (!action || isModifierCode(event.code)) return;
		event.preventDefault();
		record(undefined);
		const combo = comboOf(event);
		if (event.code === 'Escape' && !combo.ctrl && !combo.alt && !combo.shift && !combo.meta) {
			tell(keysStatus);
			return;
		}
		const next = { ...shortcuts, [action]: combo };
		const problem = problemWith(next);
		if (problem) tell(keysStatus, { tone: 'error', text: () => problems[problem](combo) });
		else void saveShortcuts(next, () => t(action === 'fold' ? 'foldIsNow' : 'unfoldIsNow', label(combo, onMac)));
	},
	{ capture: true },
);

defaultKeys.addEventListener('click', () => void saveShortcuts(defaultShortcuts, () => t('defaultsBack')));

function showScrollModifier(next: ScrollModifier): void {
	scrollModifier = next;
	useScrollModifier(next);
	for (const choice of scrollChoices) choice.checked = choice.value === next;
	if (scrollMeta) scrollMeta.textContent = heldName('meta', onMac);
	scrollCtrl.textContent = heldName('ctrl', onMac);
	scrollAlt.textContent = heldName('alt', onMac);
	scrollHint.hidden = !onMac || next === 'off';
	if (next === 'off') {
		sampleHint.textContent = t('sampleHintKeys');
		waysIntro.textContent = t('waysIntroKeys', maxRun);
	} else {
		showKeys(sampleKey, heldName(next, onMac));
		sampleHint.replaceChildren(...t('sampleHint', sampleKey));
		waysIntro.textContent = t('waysIntro', heldName(next, onMac), maxRun);
	}
}

for (const choice of scrollChoices) {
	choice.addEventListener('change', () => {
		const next = parseScrollModifier(choice.value);
		const before = scrollModifier;
		showScrollModifier(next);
		void ask({ type: 'set-scroll-modifier', modifier: next }).then((saved) => {
			tell(keysStatus, saved ? undefined : { tone: 'error', text: () => t('keysSaveFailed') });
			if (!saved) showScrollModifier(before);
		});
	});
}

for (const choice of languageChoices) {
	choice.addEventListener('change', () => void chrome.storage.sync.set({ [readerLanguageKey]: parseReaderLanguage(choice.value) }));
}

function showAutoTranslate(): void {
	const lock = aiLock();
	autoTranslate.disabled = lock !== undefined;
	autoTranslate.setAttribute('aria-checked', String(translateOn && lock === undefined));
	autoTranslateHint.hidden = lock !== undefined;
	autoTranslateReason.hidden = lock === undefined;
	autoTranslateReasonLink.textContent = lock === undefined ? '' : t(lock.reason);
}

autoTranslateReasonLink.addEventListener('click', (event) => {
	event.preventDefault();
	aiLock()?.open();
});

const element = (tag: string, text: string) => Object.assign(document.createElement(tag), { textContent: text });

function showSampleNext(): void {
	sampleNext.textContent = sampleFolded ? t(accountPage().sampleNext) : '';
}

function paint(): void {
	localize();
	const page = accountPage();
	providerSection.hidden = !page.keys;
	sitesSection.hidden = !page.sites;
	store?.show(account);
	showShortcuts(shortcuts);
	showScrollModifier(scrollModifier);
	intro.textContent = page.intro();
	paintSample(sampleWithAi());
	showSampleNext();
	privacy.replaceChildren(...page.privacy().flatMap(([term, fact]) => [element('dt', term), element('dd', fact)]));
	if (shown) describe(shown);
	refreshSave();
	showSites(disabledSites);
	record(recording);
	showAutoTranslate();
	for (const line of notices.keys()) paintNotice(line);
}

function showLanguage(setting: ReaderLanguage): void {
	for (const choice of languageChoices) choice.checked = choice.value === setting;
	paint();
}

autoTranslate.addEventListener('click', () => void chrome.storage.sync.set({ [autoTranslateKey]: !translateOn }));

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'sync' && autoTranslateKey in changes) {
		translateOn = parseAutoTranslate(changes[autoTranslateKey]?.newValue);
		showAutoTranslate();
	}
	if (area !== 'local') return;
	if ('providers' in changes || 'provider' in changes) void followStoredKeys();
	if ('disabledSites' in changes) showSites(changes.disabledSites?.newValue);
	if ('shortcuts' in changes) showShortcuts(parseShortcuts(changes.shortcuts?.newValue) ?? defaultShortcuts);
	if ('scrollModifier' in changes) showScrollModifier(parseScrollModifier(changes.scrollModifier?.newValue));
	if ('account' in changes) {
		account = parseAccount(changes.account?.newValue);
		paint();
	}
});

async function start(): Promise<void> {
	startSample(
		() => recording !== undefined,
		() => {
			sampleFolded = true;
			showSampleNext();
		},
	);
	const [local, settings, synced] = await Promise.all([
		chrome.storage.local.get(['account', 'disabledSites', 'shortcuts', 'scrollModifier']),
		stored(),
		chrome.storage.sync.get(autoTranslateKey),
	]);
	translateOn = parseAutoTranslate(synced[autoTranslateKey]);
	account = parseAccount(local.account);
	disabledSites = parseSites(local.disabledSites);
	shown = settings;
	scrollModifier = parseScrollModifier(local.scrollModifier);
	useScrollModifier(scrollModifier);
	showShortcuts(parseShortcuts(local.shortcuts) ?? defaultShortcuts);
	if (TFOLD_DEV) mountDevAccount(document.querySelector('header') as Element);
	await followReaderLanguage(showLanguage);
	show(settings);
	answerFragment();
}

void start();
