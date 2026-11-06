import { blockAt, foldOnlyIn, release } from '../content/blocks.ts';
import { listenForGestures } from '../content/gesture.ts';
import { answerWith } from '../content/model-fold.ts';
import { textOf } from '../content/text.ts';
import { localFold } from '../fold/local.ts';
import type { Level } from '../fold/types.ts';
import { language, t, type Language } from '../i18n.ts';

// Content scripts do not run on extension pages, so this page starts the same gesture, fold and morph code itself.
const stage = document.getElementById('sample-stage') as HTMLElement;
const sizer = document.getElementById('sample-sizer') as HTMLElement;
const paragraph = document.getElementById('sample-text') as HTMLElement;
const levelLine = document.getElementById('sample-level') as HTMLElement;
const compare = document.getElementById('sample-compare') as HTMLElement;
const compareQuick = document.getElementById('sample-compare-quick') as HTMLElement;
const compareAi = document.getElementById('sample-compare-ai') as HTMLElement;

const comparedAt: Level = 2;

let written: { language: Language; withAi: boolean } | undefined;
let level: Level = 0;
let compareKeepsRoom = false;

function showLevel(): void {
	const { name, about } = t(written?.withAi === false ? 'sampleQuickLevels' : 'sampleLevels')[level];
	levelLine.replaceChildren(Object.assign(document.createElement('b'), { textContent: name }), ` ${about}`);
	compareKeepsRoom ||= written?.withAi === false;
	compare.hidden = !compareKeepsRoom;
	compare.style.visibility = written?.withAi === false && level === comparedAt ? 'visible' : 'hidden';
}

function write(withAi: boolean): void {
	release();
	const example = t('sampleFold');
	const text = example.sentences.join(' ');
	sizer.textContent = text;
	paragraph.textContent = text;
	paragraph.lang = language();
	const sample = blockAt(paragraph)?.id;
	const quick = localFold(textOf(paragraph));
	if (sample) answerWith(sample, textOf(paragraph), withAi ? example : quick);
	compareQuick.textContent = quick.key;
	compareAi.textContent = example.key;
	level = 0;
}

export function startSample(recording: () => boolean, onFold: () => void): void {
	foldOnlyIn(stage, (next) => {
		level = next;
		showLevel();
		if (next > 0) onFold();
	});
	listenForGestures(() => !recording());
}

export function paintSample(withAi: boolean): void {
	if (written?.language !== language() || written.withAi !== withAi) {
		written = { language: language(), withAi };
		write(withAi);
	}
	showLevel();
}
