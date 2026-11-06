// Chrome keeps this script running in open tabs after tfold reloads, updates or goes away, but cuts it off from the
// extension that started it: chrome.runtime.id goes away and every message throws "Extension context invalidated".
const startedBy = chrome.runtime.id;
const cut = new AbortController();

export const cutOff: AbortSignal = cut.signal;

export function connected(): boolean {
	if (!cut.signal.aborted && chrome.runtime?.id !== startedBy) cut.abort();
	return !cut.signal.aborted;
}
