import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { foldAt, foldStepDelta, pointAt } from './harness.ts';

type Wheel = { ctrlKey: boolean; deltaY: number; targetId: string };
type WheelLog = { wheels: Wheel[] };

let browser: Browser;

beforeAll(async () => {
	browser = await chromium.launch();
});

afterAll(async () => {
	await browser.close();
});

async function wheelsFromFold(steps: number): Promise<Wheel[]> {
	const page = await browser.newPage();
	await page.setContent('<p id="target" style="font-size:24px">A paragraph with a wheel listener on its page.</p>');
	await page.evaluate(() => {
		const log = globalThis as unknown as WheelLog;
		log.wheels = [];
		addEventListener(
			'wheel',
			(event) => {
				const targetId = event.target instanceof Element ? event.target.id : '';
				log.wheels.push({ ctrlKey: event.ctrlKey, deltaY: event.deltaY, targetId });
			},
			{ passive: false },
		);
	});
	const box = await page.locator('#target').boundingBox();
	if (!box) throw new Error('#target is not rendered');
	await foldAt(await page.context().newCDPSession(page), box.x + 10, box.y + box.height / 2, steps);
	const wheels = await page.evaluate(() => (globalThis as unknown as WheelLog).wheels);
	await page.close();
	return wheels;
}

const totalDelta = (wheels: Wheel[]) => wheels.reduce((sum, wheel) => sum + wheel.deltaY, 0);

test('foldAt delivers wheel events with ctrlKey true to a page listener over the target', async () => {
	const wheels = await wheelsFromFold(2);
	expect(wheels.length).toBeGreaterThan(0);
	expect(wheels.every((wheel) => wheel.ctrlKey && wheel.targetId === 'target')).toBe(true);
	expect(totalDelta(wheels)).toBe(2 * foldStepDelta);
});

test('foldAt with negative steps sends negative deltaY', async () => {
	const wheels = await wheelsFromFold(-1);
	expect(wheels.every((wheel) => wheel.ctrlKey)).toBe(true);
	expect(totalDelta(wheels)).toBe(-foldStepDelta);
});

test('pointAt picks a point over the paragraph when a float covers the middle of its box', async () => {
	const page = await browser.newPage();
	await page.setContent(
		'<div id="float" style="float:right;width:70%;height:400px;background:#ccc"></div><p id="target">Words beside a float.</p>',
	);
	const box = await page.locator('#target').boundingBox();
	if (!box) throw new Error('#target is not rendered');
	const hitId = (x: number, y: number) => page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.id ?? '', [x, y] as const);
	expect(await hitId(box.x + box.width / 2, box.y + box.height / 2)).toBe('float');
	const point = await pointAt(page, await page.context().newCDPSession(page), '#target');
	expect(await hitId(point.x, point.y)).toBe('target');
	await page.close();
});
