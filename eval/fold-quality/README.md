# Fold quality eval

This eval folds a fixed set of paragraphs with the extension's own prompt and provider code, then scores each fold. Use it to check a change to `src/fold/prompt.ts` or to the provider request before you ship it.

## What it scores

Each fold is scored on six criteria:

- (a) Faithful. The Key and the Takeaway say nothing that the paragraph does not say. An LLM judge scores this.
- (b) Main point. The Takeaway states what the paragraph as a whole establishes, not one detail. The judge scores this.
- (c) Brief is shorter than Full and keeps whole sentences of the original.
- (d) The Key and the Takeaway are in the language of the paragraph.
- (e) The Takeaway is a complete sentence, which the judge scores, and it ends with a stop.
- (f) The call returns an answer that `readCompletion` accepts. A call that fails this check shows "Model fold failed" to the reader. The report also counts paragraphs of two or more sentences that an accepted answer left with no lines, which the reader sees as the local fold, and keeps the raw reply of each such call.

Criteria (c), (d) and the stop in (e) are checked by code in `lib.ts`.

The translation set adds two criteria for a Key and a Takeaway that a Korean reader gets from an English paragraph:

- (g) Natural Korean. The lines read as a Korean writer would write them, not as English word order in Korean words. The judge scores this.
- (h) Names. Each person, organization, company, product, named work and named technical term keeps its English spelling, with its Korean name in parentheses right after its first mention, as in `Neil Armstrong(닐 암스트롱)`. A Korean person or a Korean organization is written in Hangul alone, as in `봉준호` or `삼성전자`. A country, a major city or another place that Korean readers know by its Korean name is written in Korean alone, as in `중국` or `런던`. The judge scores this, and code checks the names that the item lists. The code check counts only the listed names that a line spells in English, so it cannot see a name that the line writes in Korean alone.

For a translated fold, (d) asks for Korean and reads the language by word, because the English names in a short Korean sentence can have more letters than its Hangul.

## Files

- `set.json` lists 32 paragraphs from the committed fixtures: 16 from the Korean Wikipedia page, 9 from the English Wikipedia page and 7 from the arXiv paper. Each item names its page, the first words of its paragraph, the paragraph's main point and its key facts. A `seen` field records a failure that a reader saw before. The judge never sees `seen`.
- `requests.json` holds the `FoldRequest` that the content script sends for each item, captured from `src/content/` with `capture.ts`. Items in the same window share one request, so the 32 items take 23 calls.
- `sections.json` holds the request for the first paragraph of every section of the three pages, 93 requests in all. `routing.ts` sends these requests.
- `translate-set.json` lists 24 English paragraphs written for this repository, 12 on the `reading-en` fixture page and 12 on `reading-en-more`, with proper nouns, numbers, quotations and hedged claims. Each item also lists the names that (h) checks. `requests-translate.json` holds their requests, captured with auto-translate on for a Korean reader, so the 24 items take 8 calls.
- `hand-labels.json` holds a person's labels for (a) and (b) on 30 folds of prompt version 2, 3 for each of 10 items, written before the judge ran.
- `results/<label>/r<n>.json` holds one repeat: each call's status, latency, upstream provider, tokens and cost, and each item's fold and checks. A failed call keeps the raw content.
- `results/judge-<name>.json` holds the judge's verdicts. `results/routing.json` holds the routing comparison. `results/window/<provider>.json` holds each call of the window-size latency run.

## Run it

Steps that call a provider read `OPENROUTER_API_KEY` or `OPENGATEWAY_API_KEY` from the environment. `capture.ts` needs no key.

1. Capture the requests again after a change to `src/content/` or to the fixtures:

	```sh
	npm run eval:capture
	npm run eval:capture -- --sections
	npm run eval:capture -- --set translate
	```

2. Fold the set three times, ten minutes apart:

	```sh
	npm run eval:fold -- --label v3 --repeats 3 --gap 600
	```

	`--provider opengateway` folds with the OpenGateway preset and `OPENGATEWAY_API_KEY`. The default is `--provider openrouter`. Each preset sends the request body that the extension sends. OpenGateway reports no `usage.cost`, so its calls record a cost of 0.

	`--set translate` folds the translation set. Add `--untranslated` to send the same requests without the translation, which gives the English folds of the same paragraphs and their latency and tokens. `--from 2 --repeats 3` runs repeat 2 alone, so two arms can take turns.

3. Judge the folds of one or more labels in one blind pass. The judge sees each paragraph, its reference note and every fold of that paragraph, shuffled, under the names F1, F2 and so on:

	```sh
	npm run eval:judge -- --runs v2,v3 --out final
	```

	Judge the translation set with `--set translate`. The judge also scores (g) and (h) for each Korean fold. Put the translated and the untranslated folds of the same paragraphs in one pass, so both are judged side by side under the same rubric.

4. Print the table. It gives each criterion's mean over the repeats and each repeat's value:

	```sh
	npm run eval:report -- --runs v2,v3 --judge final
	```

5. Compare the judge with the hand labels:

	```sh
	npm run eval:agree -- --judge validate-low
	```

6. Compare provider routing. Each pass alternates the arms call by call and swaps the order on the next pass:

	```sh
	npm run eval:routing -- --pass 0
	```

7. Time translated windows of 1, 2, 3, 4 and 8 paragraphs of the translation set, and an untranslated window of 8. Each round sends 3 calls per arm, one arm after another, and rotates the order of the arms, so drift and upstream changes fall on every arm alike. Calls wait up to 30 s, past the extension's deadline, so the slow tail shows:

	```sh
	npm run eval:window -- --provider openrouter --rounds 6
	```

## Read the numbers with care

OpenRouter keeps a prompt on the provider that last served it. The same request went to the same upstream in each repeat, even ten minutes apart, so the spread between repeats is the model's sampling spread on mostly the same providers. It is not the spread of provider routing. Every call records its upstream, and `report.ts` prints the calls and failures per upstream.

The judge is `anthropic/claude-sonnet-5.5` at low effort. Sonnet 5.5 takes no reasoning budget. With the earlier 1024-token budget, one OpenRouter upstream reasoned for 3,119 tokens, ran past `max_tokens` and cut the answer off, and another did not reason at all. On the 30 hand-labelled folds the low-effort judge agrees on 24 for (a) and on 24 for (b) (`results/judge-validate-low.json`). On (a) it failed 4 folds that the hand label passed and passed 2 that it failed. Each time it disagreed on (b), it failed a fold that the hand label passed, so its main point rate is a lower bound. The judge sends up to 20 folds per call, and an item whose answer fails three times is left out of the pass and named in the report.
