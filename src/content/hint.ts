import { t } from '../i18n.ts';
import { ask } from '../messages.ts';
import { blockAt } from './blocks.ts';
import { connected } from './connection.ts';

const restMs = 1000;
const shownMs = 6000;
const gapPx = 8;

type Timer = ReturnType<typeof setTimeout>;
type Hint =
	| { state: 'off' }
	| { state: 'armed'; timer: Timer | undefined }
	| { state: 'claiming' }
	| { state: 'shown'; host: HTMLElement; anchor: Element; timer: Timer };

const hostStyle =
	'all:initial!important;position:fixed!important;z-index:2147483647!important;pointer-events:none!important;visibility:hidden!important';
export const tipLook =
	'font:500 12px/1.4 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;letter-spacing:-.01em;color:#fff;background:#2a2a2e;' +
	'padding:6px 10px;border:1px solid rgba(255,255,255,.16);border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.18);' +
	`box-sizing:border-box;max-width:calc(100vw - ${2 * gapPx}px);word-break:keep-all;overflow-wrap:break-word`;
const tipStyle =
	`div{${tipLook};animation:in .18s ease-out}` +
	'b{font-weight:500;color:#c9fb2c;white-space:nowrap}' +
	'@keyframes in{from{opacity:0;transform:translateY(3px)}}@media (prefers-reduced-motion:reduce){div{animation:none}}';

let hint: Hint = { state: 'off' };
let keys: { fold: string; unfold: string; scroll: string | undefined } = { fold: '', unfold: '', scroll: undefined };

function spot(anchor: Element, host: HTMLElement): { top: number; left: number } | undefined {
	const box = anchor.getBoundingClientRect();
	const { width, height } = host.getBoundingClientRect();
	const fits = (top: number) => top >= gapPx && top + height <= innerHeight - gapPx;
	const top = [box.top - gapPx - height, box.bottom + gapPx].find(fits);
	return top === undefined ? undefined : { top, left: Math.max(gapPx, Math.min(box.left, innerWidth - width - gapPx)) };
}

function place(): void {
	if (hint.state !== 'shown') return;
	const { host, anchor } = hint;
	const at = spot(anchor, host);
	host.style.setProperty('visibility', at ? 'visible' : 'hidden', 'important');
	if (!at) return;
	host.style.setProperty('top', `${at.top}px`, 'important');
	host.style.setProperty('left', `${at.left}px`, 'important');
}

function tip(): HTMLElement {
	const host = document.createElement('tf-hint');
	host.style.cssText = hostStyle;
	const css = document.createElement('style');
	css.textContent = tipStyle;
	const shortcut = (shown: string) => Object.assign(document.createElement('b'), { textContent: shown });
	const text = document.createElement('div');
	text.append(...(keys.scroll ? t('hint', shortcut(keys.scroll), shortcut(keys.fold), shortcut(keys.unfold)) : t('hintKeys', shortcut(keys.fold), shortcut(keys.unfold))));
	host.attachShadow({ mode: 'open' }).append(css, text);
	document.documentElement.append(host);
	return host;
}

async function rest(x: number, y: number): Promise<void> {
	if (!connected()) return;
	const under = document.elementFromPoint(x, y);
	const block = under ? blockAt(under) : undefined;
	if (hint.state !== 'armed' || !block) return;
	const anchor = block.overlay ?? block.el;
	const host = tip();
	if (!spot(anchor, host)) {
		host.remove();
		return;
	}
	removeEventListener('pointermove', onMove);
	hint = { state: 'claiming' };
	const granted = await ask({ type: 'claim-hint' });
	if (hint.state !== 'claiming' || !granted) {
		host.remove();
		if (hint.state === 'claiming') hint = { state: 'off' };
		return;
	}
	hint = { state: 'shown', host, anchor, timer: setTimeout(dismissHint, shownMs) };
	place();
	addEventListener('scroll', place, { capture: true, passive: true });
	addEventListener('resize', place, { passive: true });
}

function onMove(event: PointerEvent): void {
	if (hint.state !== 'armed' || !event.isTrusted) return;
	clearTimeout(hint.timer);
	const { clientX, clientY } = event;
	hint.timer = setTimeout(() => void rest(clientX, clientY), restMs);
}

export function armHint(fold: string, unfold: string, scroll: string | undefined): void {
	keys = { fold, unfold, scroll };
	if (hint.state !== 'off') return;
	hint = { state: 'armed', timer: undefined };
	addEventListener('pointermove', onMove, { passive: true });
}

export function dismissHint(): void {
	if (hint.state === 'armed') {
		clearTimeout(hint.timer);
		removeEventListener('pointermove', onMove);
	}
	if (hint.state === 'shown') {
		clearTimeout(hint.timer);
		hint.host.remove();
		removeEventListener('scroll', place, { capture: true });
		removeEventListener('resize', place);
	}
	hint = { state: 'off' };
}

let foldNoted = false;

export function noteFold(): void {
	if (!foldNoted) {
		foldNoted = true;
		void ask({ type: 'note-fold' });
	}
	if (hint.state === 'armed') void ask({ type: 'claim-hint' });
	dismissHint();
}
