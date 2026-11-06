import { parseAccount, type Account } from '../account.ts';
import { ask } from '../messages.ts';

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const choices: { id: string; label: string; account: () => Account; matches: (account: Account) => boolean }[] = [
	{ id: 'signedOut', label: 'Signed out · 로그아웃', account: () => ({ kind: 'signedOut' }), matches: ({ kind }) => kind === 'signedOut' },
	{ id: 'free', label: 'Free · 무료', account: () => ({ kind: 'free' }), matches: ({ kind }) => kind === 'free' },
	{
		id: 'pro',
		label: 'Pro trial, 72% left · Pro 체험, 72% 남음',
		account: () => ({ kind: 'pro', trialEndsAt: inDays(7), remainingPercent: 72, resetsAt: inDays(30) }),
		matches: (account) => account.kind === 'pro' && account.remainingPercent > 0,
	},
	{
		id: 'pro-empty',
		label: 'Pro, 0% left · Pro, 0% 남음',
		account: () => ({ kind: 'pro', remainingPercent: 0, resetsAt: inDays(12) }),
		matches: (account) => account.kind === 'pro' && account.remainingPercent === 0,
	},
];

export function mountDevAccount(after: Element): void {
	const section = document.createElement('section');
	section.id = 'dev-account';
	section.setAttribute('aria-labelledby', 'dev-account-heading');
	const heading = document.createElement('h2');
	heading.id = 'dev-account-heading';
	heading.textContent = 'Development build: account · 개발용 계정 상태';
	const hint = document.createElement('p');
	hint.className = 'hint';
	hint.textContent = 'Sign-in does not exist yet, so this build sets the account here. Store builds leave this section out.';
	const buttons = choices.map(({ id, label, account }) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'button';
		button.dataset.account = id;
		button.textContent = label;
		button.addEventListener('click', () => void ask({ type: 'set-account', account: account() }));
		return button;
	});
	const actions = document.createElement('div');
	actions.className = 'actions';
	actions.append(...buttons);
	section.append(heading, hint, actions);
	after.after(section);

	const show = (raw: unknown) => {
		const account = parseAccount(raw);
		for (const [i, button] of buttons.entries()) button.setAttribute('aria-pressed', String(choices[i]?.matches(account) === true));
	};
	void chrome.storage.local.get('account').then(({ account }) => show(account));
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && 'account' in changes) show(changes.account?.newValue);
	});
}
