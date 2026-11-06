import { followReaderLanguage } from '../i18n.ts';
import { ask, type Tell } from '../messages.ts';
import { heldName, label, onMac } from '../shortcuts.ts';
import { blockAt, readBlocks, release, setLevel, unfoldAll } from './blocks.ts';
import { connected, cutOff } from './connection.ts';
import { listenForGestures, useScrollModifier, useShortcuts } from './gesture.ts';
import { armHint, dismissHint } from './hint.ts';
import { watchTranslation } from './model-fold.ts';
import { ensureStyle, relabelBadges } from './overlay.ts';
import { removeBar } from './target-bar.ts';

let listening: AbortController | undefined;

function whileConnected<E extends Event>(handle: (event: E) => void): (event: E) => void {
	return (event) => {
		if (connected()) handle(event);
	};
}

function turn(on: boolean): void {
	if (on === (listening !== undefined)) return;
	if (on) {
		listening = new AbortController();
		listenForGestures(connected, listening.signal);
		return;
	}
	listening?.abort();
	listening = undefined;
	removeBar();
	dismissHint();
	unfoldAll();
}

function standDown(): void {
	listening?.abort();
	listening = undefined;
	removeBar();
	dismissHint();
	release();
}

async function sync(): Promise<void> {
	const page = await ask({ type: 'page' });
	if (!page) return;
	useShortcuts(page.shortcuts);
	useScrollModifier(page.scrollModifier);
	turn(page.on);
	if (page.hint) armHint(label(page.shortcuts.fold, onMac), label(page.shortcuts.unfold, onMac), page.scrollModifier === 'off' ? undefined : heldName(page.scrollModifier, onMac));
}

function start(): void {
	// A copy that Chrome cut off in this tab may still show folds. Adding this copy's style wakes such a copy so it puts
	// its paragraphs back, and the style hides what a copy from before tokens shows.
	ensureStyle();
	cutOff.addEventListener('abort', standDown);
	void sync();
	void followReaderLanguage(relabelBadges, connected);
	watchTranslation();
	chrome.runtime.onMessage.addListener((message: Tell) => {
		const syncs = message.type === 'shortcuts' || message.type === 'account' || message.type === 'language' || (message.type === 'site' && message.host === location.hostname);
		if (syncs) void sync();
	});
	addEventListener(
		'visibilitychange',
		whileConnected(() => {
			if (document.visibilityState === 'visible') void sync();
		}),
		{ signal: cutOff },
	);
	Object.assign(globalThis, { __tfold: { readBlocks, setLevel, blockAt } });
	console.log('content ready');
}

// A page that loads while tfold starts in open tabs gets this script from the manifest and from the background too.
if (!('__tfold' in globalThis)) start();
