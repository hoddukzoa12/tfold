import { signInUrl, type Account } from '../account.ts';
import { t, type TextKey } from '../i18n.ts';

// What settings says and shows for one kind of account. aiLock says what stands between this reader and AI summaries, if anything, and where its link goes.
export type AccountPage = {
	intro: () => string;
	privacy: () => [string, string][];
	sampleNext: TextKey;
	keys: boolean;
	sites: boolean;
	aiLock: (keyed: boolean) => { reason: TextKey; open: () => void } | undefined;
};

export function storeAccount(free: AccountPage) {
	const signIn = document.getElementById('sign-in') as HTMLButtonElement;
	signIn.addEventListener('click', () => void chrome.tabs.create({ url: signInUrl }));
	const toSignIn = () => {
		signIn.scrollIntoView({ block: 'center' });
		signIn.focus({ preventScroll: true });
	};
	const pages: Record<Account['kind'], AccountPage> = {
		signedOut: {
			intro: () => `${t('popupSignedOut')} ${t('popupSignedOutUnlock')}`,
			privacy: () => t('privacySignedOut'),
			sampleNext: 'sampleNextSignedOut',
			keys: false,
			sites: false,
			aiLock: () => ({ reason: 'autoTranslateNeedsSignIn', open: toSignIn }),
		},
		free,
		pro: {
			intro: () => t('settingsIntroPro'),
			privacy: () => t('privacyPro'),
			sampleNext: 'sampleNext',
			keys: false,
			sites: true,
			aiLock: () => undefined,
		},
	};
	return {
		pageOf: ({ kind }: Account) => pages[kind],
		show: ({ kind }: Account) => {
			signIn.hidden = kind !== 'signedOut';
		},
	};
}
