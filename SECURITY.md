# Security policy

## Report a problem privately

Email **admin@tfold.xyz**. Do not open a public issue or pull request for a security problem.

Include the release or commit you tested, the steps to reproduce the problem, and what an attacker gains. You will get a first reply within a reasonable time. tfold is a small pre-release project, so it promises no fix deadline, and it pays no bounty.

## Supported versions

Only the latest release and the latest `main` are supported. tfold is not on the Chrome Web Store yet.

## What is in scope

- How tfold stores, reads and sends API keys.
- The message boundary of the service worker: a page, a content script or another extension that gets the worker to do something it should refuse.
- Content script injection: a page that gets its own markup or script to run with the content script's access, or that uses a fold to change what a reader sees.
- Page data sent to providers: anything that leaves the browser beyond what this file describes.

A provider's own handling of the text it receives is out of scope. Report that to the provider.

## How tfold behaves today

This section describes the source on `main`. If you find that the code does otherwise, that is a report we want.

### Editions

- `npm run build` makes the open edition. It has no account, ignores a stored one, refuses `set-account`, and makes no request to `tfold.xyz`.
- `npm run build:store` makes the store edition, which has sign-in, Free and Pro accounts. Statements below about accounts apply only to the store edition.
- `npm run build:dev` makes the store edition with its one development tool, the account switch. `scripts/build.ts` compiles it out of the other two builds.

### API keys

- Keys stay in `chrome.storage.local`, and tfold does not encrypt them. The service worker limits that storage to trusted contexts, so content scripts cannot read it, and tfold does not put keys in `chrome.storage.sync`.
- A key leaves the browser only in the `Authorization` header of a request to its own provider. The presets are `https://apis.opengateway.ai/v1` and `https://openrouter.ai/api/v1`. The settings page has no field for another address.
- When you click **Save key**, the worker checks each typed key with one request to that key's provider, with an 8 second timeout. For OpenGateway the request is `POST https://apis.opengateway.ai/v1/chat/completions` with a body that names only the model. The body has no messages, so no model runs. For OpenRouter the request is `GET https://openrouter.ai/api/v1/key`. Neither request holds page text.
- tfold neither sends nor saves a typed key that is not one unbroken line of up to 2048 printable ASCII characters. A key that the provider refuses with a 401 or a 403 is not saved. A key is saved with a warning when the check cannot decide, for example when the provider cannot be reached.
- When a provider refuses a saved key during a fold, the worker writes the provider's address, the key and the model to `chrome.storage.session`, without encryption, so that it does not ask again with the same key. The browser clears that storage when it closes, and Chrome keeps it from content scripts by default.
- The service worker logs the provider's host, the model, token counts, key check results with their HTTP status, and error details. It does not log keys or page text.

### The message boundary

- The worker ignores any message whose sender is not this extension. The manifest declares no `externally_connectable`, so web pages cannot message it.
- Changing a site's on or off state is accepted only from the settings page and the popup. Changing shortcuts or the scroll key is accepted only from the settings page.
- Setting the account (`set-account`) is accepted only in a `build:dev` build, and only from the settings page. The open and store editions refuse it.
- A key check (`check-key`) is accepted only from the settings page. From any other sender the worker sends no request.
- `note-fold` is accepted from any part of the extension, and content scripts send it after a fold. It sets one stored flag, `hasFolded`, which the popup reads to style its **Add a key** button and to place its how-to. It carries no page data and starts no request.

### The content script

- The manifest runs the content script on every page Chrome allows an extension on, which includes every `http` and `https` page. It runs in the main frame and in Chrome's isolated world. The worker also starts it in tabs that were open when tfold was installed, updated or turned back on.
- Before it starts the script in an open tab, the worker sends a `ping` message to the tab's main frame, and a tab whose script answers keeps that script. The popup sends the same message to the active tab to learn whether tfold can run there. The message has only its type, and the answer has no data. Pages cannot see this message.
- A fold starts only from a trusted event, so a page cannot trigger one by dispatching a wheel or key event of its own.
- Chromium reports a zoom gesture as a wheel event with Control set and no Control key down. The content script never cancels such an event, so the browser zooms as it would with no extension. A Control key that the page never saw go down reads the same way, so that wheel goes to the browser too.
- The content script reads each wheel event after the page has, on its way back up. It cancels a wheel with the scroll key held only over a paragraph or inside the line that marks a run, and only when the page did not cancel the wheel itself. Any other wheel stays with the page and the browser.
- The target line and its note about the run limit live in a `tf-bar` element with an open shadow root on the page, so a page can see them. They hold no page text.
- Key and Takeaway are shown as text nodes, so model output cannot add markup to the page. Brief is built from copies of the page's own nodes.
- Page text goes to the model as input, so a page can try to steer what the model writes. That is a known limit, and reports of a real effect beyond the shown text are in scope.

### Page data

- No page text leaves the browser until you fold a paragraph on the page. A quick summary is computed on your machine.
- In the open edition, and on a Free account in the store edition, tfold sends page text only with a saved key. When you fold a paragraph that has no model text yet, tfold sends that paragraph and up to seven neighbors in the same section, or up to two when translation applies, with the page title and the page's headings. A run of up to 20 paragraphs folded together goes in as many such requests as it takes, and marking a run sends nothing. The page URL is not part of the request to the provider.
- **Fold other languages into** your language is on by default, and turning it off is kept. With it on, a fold can send text before you fold that text. After a fold whose request was translated, tfold picks the next paragraph after that request in reading order that needs translating and has no answer yet. It sends that paragraph, with up to two neighbors in the same section that need the same translation, as soon as one of two things happens. Either you have folded two paragraphs of the last request, or the picked paragraph is in the middle 30% of the window's height. Each fold allows one such request. A failed request, a request that needs no translation, or turning tfold off on the page stops it. With the switch off, nothing goes ahead.
- If the chosen provider is busy or cannot be reached and you saved a key for the other one, tfold sends the same text to the other one.
- In the store edition, a Pro account sends nothing. tfold has no server for Pro yet, so the worker answers before it makes a request, even when an old key is still in storage. The fold stays a quick summary, with no error badge.
- Model text is cached in the extension's IndexedDB, keyed by a hash of the paragraph and the page URL. The cache stays on your machine.
- Provider requests, meaning folds and key checks, are the only network requests that the extension's code makes. In the store edition while you are signed out, the sign-in buttons in the popup and in settings open a tab on `tfold.xyz`. The **Get a key** links in settings also open a tab, on the provider's site.
