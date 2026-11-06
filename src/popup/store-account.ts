import { canFold, signInUrl, trialDaysLeft, type Account, type SignedIn } from '../account.ts';
import { language, t } from '../i18n.ts';
import { sampleFragment } from '../messages.ts';

const lowUsagePercent = 10;
const urgentTrialDays = 3;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const resetDay = (resetsAt: string) =>
	new Intl.DateTimeFormat(language(), { month: 'short', day: 'numeric' }).format(new Date(resetsAt)).replaceAll(' ', ' ');

function mountDevLink(signedOutView: HTMLElement, openSettings: () => Promise<void>): void {
	const link = document.createElement('a');
	link.className = 'dev-link';
	link.href = '../options/options.html';
	link.textContent = 'Development build: set the account · 개발용 계정 바꾸기';
	link.addEventListener('click', (event) => {
		event.preventDefault();
		void openSettings();
	});
	signedOutView.append(link);
}

export function storeAccount() {
	const signedOutView = byId('signed-out');
	const usage = byId('usage');
	const usageLeft = byId('usage-left');
	const usageLow = byId('usage-low');
	const usageReset = byId('usage-reset');
	const trialLeft = byId('trial-left');
	const meter = byId('meter');

	function showTrial(trialEndsAt: string | undefined): void {
		const days = trialEndsAt === undefined ? undefined : trialDaysLeft(trialEndsAt, Date.now());
		trialLeft.hidden = days === undefined;
		trialLeft.textContent = days === undefined ? '' : t('trialLeft', days);
		trialLeft.classList.toggle('urgent', days !== undefined && days <= urgentTrialDays);
	}

	function showUsage(account: SignedIn): void {
		usage.hidden = account.kind !== 'pro';
		if (account.kind !== 'pro') return;
		const { remainingPercent, resetsAt, trialEndsAt } = account;
		usage.classList.toggle('low', remainingPercent <= lowUsagePercent);
		usageLeft.textContent = t('usageLeft', remainingPercent);
		usageLow.hidden = remainingPercent === 0 || remainingPercent > lowUsagePercent;
		usageLow.textContent = t('usageLow');
		usageReset.textContent = t('usageResets', resetDay(resetsAt));
		showTrial(trialEndsAt);
		meter.setAttribute('aria-label', t('usageMeter'));
		meter.setAttribute('aria-valuenow', String(remainingPercent));
		meter.setAttribute('aria-valuetext', t('usageLeft', remainingPercent));
		meter.style.setProperty('--remaining', `${remainingPercent}%`);
	}

	return {
		show(account: Account): void {
			signedOutView.hidden = canFold(account);
			if (canFold(account)) showUsage(account);
		},
		foldSource: (account: SignedIn): [string, string] | undefined =>
			account.kind === 'pro' ? [t(account.remainingPercent > 0 ? 'popupProTitle' : 'popupProEmptyTitle'), ''] : undefined,
		listen(openSettings: (fragment?: string) => Promise<void>): void {
			byId('continue').addEventListener('click', () => void chrome.tabs.create({ url: signInUrl }).then(() => close()));
			byId('try-first').addEventListener('click', (event) => {
				event.preventDefault();
				void openSettings(sampleFragment);
			});
			if (TFOLD_DEV) mountDevLink(signedOutView, openSettings);
		},
	};
}
