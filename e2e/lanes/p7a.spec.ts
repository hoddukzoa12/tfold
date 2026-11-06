import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { failedWaitMs } from '../../src/messages.ts';
import { fixtures, type Harness } from '../harness.ts';
import { expect, test } from '../lane.ts';

const latchMs = 400;
const lead = '#mwAQ > p:not(.mw-empty-elt):not([data-tfold-overlay])';
const failedBadge = 'AI 요약을 만들지 못했어요 · 한 번 더 해 보세요';

type Choice = { finish_reason: string; message: { role: 'assistant'; content: string; reasoning_content?: string } };
type Usage = { prompt_tokens: number; completion_tokens: number; completion_tokens_details?: { reasoning_tokens: number } };
type Reply = { choices: Choice[]; usage: Usage };
type Sent = { max_tokens: number; reasoning_effort?: string; messages: { content: string }[] };
type Shown = { level: string | null; fold: string | null; badge: string | null; text: string | null };

async function mockProvider(replyTo: (prompt: string, call: number) => Reply) {
	const sent: Sent[] = [];
	const server = http.createServer((request, response) => {
		const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type' };
		if (request.method === 'OPTIONS') {
			response.writeHead(204, cors).end();
			return;
		}
		let raw = '';
		request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
		request.on('end', () => {
			const body = JSON.parse(raw) as Sent;
			sent.push(body);
			const reply = replyTo(body.messages.at(-1)?.content ?? '', sent.length);
			response.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ id: 'gen-mock', ...reply }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		sent,
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

const foldedBy = (prompt: string): Reply => {
	const units = [...prompt.matchAll(/^\[U(\d+)\]/gm)].map(([, n]) => ({ id: `U${n}`, point: 'The point.', takeaway: `완전한 답 ${n}`, reason: '', evidence: [0] }));
	return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ units }) } }], usage: { prompt_tokens: 1805, completion_tokens: 390 } };
};

const shown = (page: Page): Promise<Shown> =>
	page.evaluate((lead) => {
		const overlay = document.querySelector(lead)?.nextElementSibling;
		const own = overlay?.hasAttribute('data-tfold-overlay') ? overlay : null;
		return {
			level: own?.getAttribute('data-tf-level') ?? null,
			fold: own?.getAttribute('data-tf-fold') ?? null,
			badge: own?.getAttribute('data-tf-badge') ?? null,
			text: own ? (own.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
		};
	}, lead);

async function foldLead(h: Harness): Promise<void> {
	await h.page.evaluate((lead) => {
		for (const marked of document.querySelectorAll('[data-p7a-target]')) marked.removeAttribute('data-p7a-target');
		const el = document.querySelector(lead);
		(el?.checkVisibility() ? el : el?.nextElementSibling)?.setAttribute('data-p7a-target', '');
	}, lead);
	const point = await h.pointAt('[data-p7a-target]');
	await h.foldAt(point.x, point.y, 1);
}

async function settledAt(h: Harness, level: string, want: (now: Shown) => boolean): Promise<Shown> {
	const reached = async () => {
		const now = await shown(h.page);
		return now.level === level && want(now);
	};
	await expect.poll(reached, { timeout: 15_000, intervals: [50] }).toBe(true);
	return shown(h.page);
}

const failureLines = (h: Harness) => h.logs.filter((entry) => entry.source === 'worker' && entry.text.startsWith('fold failed')).map((entry) => entry.text.replace(/, \d+ ms$/, ''));

const reasoningOnly: Reply = {
	choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: 'One unit. The main point is' } }],
	usage: { prompt_tokens: 1805, completion_tokens: 850, completion_tokens_details: { reasoning_tokens: 850 } },
};
const answerCutOff: Reply = {
	choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"units": [{"id": "U0", "point": "The point.", "takeaway": "잘린 답', reasoning_content: 'One unit.' } }],
	usage: { prompt_tokens: 1805, completion_tokens: 850, completion_tokens_details: { reasoning_tokens: 595 } },
};

test.describe('a reply cut off by max_tokens', () => {
	test.use({ allowLiveHosts: ['127.0.0.1'], lang: 'ko' });

	for (const [name, reply, tokens] of [
		['all of it reasoning, with no answer', reasoningOnly, '850 output tokens, 850 of them reasoning'],
		['an answer that stops mid-string', answerCutOff, '850 output tokens, 595 of them reasoning'],
	] as const) {
		test(`${name}: the reader sees the local fold and the failure badge, a later fold asks again, and only a whole answer is shown and cached`, async ({ h }) => {
			const mock = await mockProvider((prompt, call) => (call <= 2 ? reply : foldedBy(prompt)));
			try {
				await h.worker.evaluate(
					async (baseUrl) => {
						await chrome.storage.sync.set({ autoTranslate: true, readerLanguage: 'ko' });
						await chrome.storage.local.set({ hintSeen: true, providers: { chosen: 'opengateway', opengateway: { apiKey: 'mock-key', baseUrl } } });
					},
					mock.baseUrl,
				);
				await h.navigate(fixtures.wiki);

				await foldLead(h);
				const first = await settledAt(h, '1', (now) => now.badge !== null);
				await h.page.waitForTimeout(failedWaitMs + 100);
				await foldLead(h);
				const again = await settledAt(h, '2', (now) => now.badge !== null);
				const askedWhileCut = mock.sent.length;

				await h.navigate(fixtures.wiki);
				await foldLead(h);
				await settledAt(h, '1', (now) => now.fold === 'model');
				await h.page.waitForTimeout(latchMs + 100);
				await foldLead(h);
				const answered = await settledAt(h, '2', (now) => now.fold === 'model');
				const askedOnce = mock.sent.length;
				await h.navigate(fixtures.wiki);
				await foldLead(h);
				const cached = await settledAt(h, '1', (now) => now.fold === 'model');
				console.log(`cut off: ${JSON.stringify(first)}; later how: ${JSON.stringify(again)}; whole answer: ${JSON.stringify(answered)}; ${JSON.stringify(failureLines(h))}`);

				expect(first).toMatchObject({ fold: 'local', badge: failedBadge });
				expect(again).toMatchObject({ fold: 'local', badge: failedBadge });
				expect(again.text, 'no cut-off words reach the page').not.toContain('잘린 답');
				expect(askedWhileCut, 'the later fold asks again').toBe(2);
				expect(failureLines(h)).toEqual(Array.from({ length: 2 }, () => `fold failed, failed, finish_reason length, ${tokens}`));
				expect(answered).toMatchObject({ fold: 'model', badge: null });
				expect(answered.text).toContain('완전한 답');
				expect(askedOnce, 'nothing of the cut-off replies was cached').toBe(3);
				expect(cached).toMatchObject({ fold: 'model', badge: null });
				expect(mock.sent.length, 'the whole answer was cached').toBe(3);
				expect(mock.sent[0]).toMatchObject({ reasoning_effort: 'none' });
				expect(h.logs.filter((entry) => entry.type === 'error' || entry.type === 'pageerror')).toEqual([]);
			} finally {
				await mock.close();
			}
		});
	}
});
