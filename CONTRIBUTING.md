# Contributing to tfold

tfold is a Chrome MV3 extension written in TypeScript. This guide says how to set it up, which checks to run, and what a pull request needs.

## Set up

You need Node 22 or newer. The scripts run TypeScript directly with Node.

```sh
npm ci
npx playwright install --with-deps chromium
```

## Know the editions

One repository makes two editions, and each build has its own folder.

| Command | Folder | What you get |
| --- | --- | --- |
| `npm run build` | `dist/` | The open edition. It has no account and folds at once. |
| `npm run build:store` | `dist-store/` | The store edition. It starts signed out and folds nothing until an account is set. |
| `npm run build:dev` | `dist-dev/` | The store edition with its development tool: a section at the top of settings that sets the account without signing in. |
| `npm run package:open` | `tfold-open.zip` | Builds the open edition and zips `dist/`. This is the file for a GitHub release and for the Chrome Web Store, and [docs/store-listing.md](docs/store-listing.md) holds the store listing. |
| `npm run package:store` | `tfold-store.zip` | Builds the store edition and zips `dist-store/`. This edition folds nothing until sign-in exists, so do not upload it yet. |

To use the extension by hand, run `npm run build`, load `dist/` unpacked from `chrome://extensions`, and fold. After a rebuild, click **Reload** on the tfold card. A Chrome restart alone keeps the old service worker.

What only the store has sits behind one `TFOLD_EDITION` check per surface, and the bundler removes it from the open edition.

The test paragraph under **Try it here** in settings folds in every build, with no key and no network request. To get model text, save a key under **AI summaries**. OpenGateway is the default, and **Advanced** has **Use OpenRouter instead**. **Save key** sends the key to its provider to check it, so a lane that saves a key answers that request itself or names the provider's host.

## Run the checks

Run these three before you open a pull request. The repository has no CI workflow, so nothing runs them for you.

```sh
npm run lint
npm run typecheck
npm test
```

Then run the end-to-end lanes that cover your change. `npm run e2e` builds both editions first, and a filter after `--` picks the specs:

```sh
npm run e2e -- smoke
npm run e2e -- lanes/p5f
```

Playwright matches the filter against the absolute path, so `p1` alone also matches every spec in a directory named `p1-scaffold`.

## Know which lanes need a live key

The lanes run offline by default. `e2e/harness.ts` aborts every request that leaves the fixture server and fails the lane. Most lanes need no key. A lane that needs a provider names its host, and skips itself when its key is not set.

| Key | Lanes |
| --- | --- |
| `OPENROUTER_API_KEY` | The live tests in `e2e/lanes/p3.spec.ts` and `e2e/lanes/p7.spec.ts`, and the probes in `p3`, `p4` and `p5` that record video or measure routing |
| `OPENGATEWAY_API_KEY` | The live tests in `e2e/lanes/p5c.spec.ts` and `e2e/lanes/p6a.spec.ts`, and their review videos |

The live test in `e2e/lanes/p5f.spec.ts` needs both keys. Some lanes also need `TFOLD_PROBE`, for example `TFOLD_PROBE=perf` or `TFOLD_PROBE=video`, and skip themselves without it. The fold-quality scripts under `eval/fold-quality/` call live models with the same two keys.

Never commit a key, and never put one in a log, a screenshot or a video.

A change to `README.md` also changes `README.ko.md` in the same pull request.

A change a reader would notice adds a line under **Unreleased** in `CHANGELOG.md`. A release moves those lines under its version and date, and raises the version in `package.json`, `package-lock.json` and `src/manifest.json`.

## Scripts

- `npm run build` runs `scripts/build.ts`. It bundles the content script, the service worker, the settings page and the toolbar popup with esbuild, and copies the manifest, the pages, the shared stylesheet, the store name and description in `src/_locales/` and the icons into `dist/`, as the open edition. Every other string the extension shows lives in `src/strings/`, in English and Korean, and the reader picks the language in settings.
- `npm run build:store` builds the store edition into `dist-store/`. It starts signed out.
- `npm run build:dev` builds the store edition with its development tool into `dist-dev/`.
- `npm run package:open` builds the open edition and zips it as `tfold-open.zip`, the file for a GitHub release and for the Chrome Web Store.
- `npm run package:store` builds the store edition and zips it as `tfold-store.zip`. Do not upload it until sign-in exists.
- `npm run icons` draws `assets/brand/tfold-mark.svg` into the PNG icons in `src/icons/` with Playwright's Chromium.
- `npm run lint` runs ESLint. `npm run typecheck` runs `tsc`.
- `npm test` runs the Vitest unit tests.
- `npm run e2e` builds the open and store editions, then runs the Playwright specs under `e2e/`.
- `npm run perf:boot` runs `npm run e2e -- smoke` ten times and prints each boot time and the median. It fails when the median is over 5 seconds.
- `npm run fixtures:capture` captures the Wikipedia and arXiv fixtures again from the live sites.
- `npm run eval:capture`, `eval:fold`, `eval:judge`, `eval:agree`, `eval:report`, `eval:routing` and `eval:window` run the fold-quality scripts in `eval/fold-quality/`.

## The end-to-end harness

`e2e/harness.ts` starts a fixture server on a random local port and launches Playwright's Chromium with the unpacked store edition from `dist-store/`, or from the directory passed as `launch()`'s second argument. `editionDirs.open` is `dist/`, and the lanes for the open edition in `e2e/lanes/p8.spec.ts` pass it. It prints `extension ready <id> in <ms> ms` when the service worker is up. Lanes import `test` from `e2e/lane.ts`, which gives each test a new harness `h`.

The harness aborts every request from a page or the service worker that leaves the fixture server, except `chrome:`, `chrome-extension:`, `about:` and `data:` URLs, and lists it in `h.blockedRequests`. `h.close()` then throws, so the lane fails. A lane that must reach a live API names its host, as in `test.use({ allowLiveHosts: ['openrouter.ai'] })`. The website host does not resolve at all, because a tab the extension opens can start loading before the harness sees it. `launch({ lang: 'ko' })` starts a Korean browser by setting `LANGUAGE`, which Chromium on Linux reads for its own language.

- `h.navigate(url)` loads a fixture path, such as `fixtures.wiki`, or an absolute URL.
- `h.pointAt(selector)` scrolls the first match into view, moves the pointer onto the visible part of its content nearest its middle, and returns that point. It checks the point with `elementFromPoint`, so a float that covers part of the box never takes the event. It throws when no visible part of the match can take the pointer.
- `h.foldAt(x, y, steps)` holds the real Control key and sends CDP wheel events with the Ctrl modifier, which is how a reader away from a Mac folds. One step is a `deltaY` of `foldStepDelta` in five events. A positive step folds, and a negative step unfolds.
- `h.click(selector)` points at the first match and clicks it.
- `h.readBlocks()` returns the id and level of each block. It calls `globalThis.__tfold.readBlocks()` in the content script's isolated world.
- `h.logs` holds every console message from the page and the service worker, and every uncaught page error.
- `h.showText(title, text)` shows text in the page so a lane can save a screenshot of command output.

The lanes for each pull request live in `e2e/lanes/<pr-id>.spec.ts` and save their screenshots to `e2e/out/<pr-id>/`.

## Keep fixtures original or properly licensed

Every page under `e2e/fixtures/` holds either text you wrote for this repository or text whose license allows it to be here, such as CC BY-SA 4.0. Do not add a copy of a site's content without that license. Do not add a font whose license forbids redistribution, which is why `npm run fixtures:capture` drops Adobe Fonts stylesheets.

Add an entry to `e2e/fixtures/README.md` for each new fixture. The entry says where the text comes from, its date and its license, or that it is original content written for this repository. Invent any names and handles in a fixture shaped like a real site.

The same rule covers the demo page and the media under `docs/media/`.

## Open a pull request

- Keep one change in one pull request, and say why it exists and how you proved it works.
- Write the title as a Conventional Commit, such as `fix(content): keep links in the Brief level`.
- Add or change a lane in `e2e/lanes/` when behavior changes, and assert what a reader can see.
- Put each new string in both `src/strings/en.ts` and `src/strings/ko.ts`.
- For a visible change, attach a screenshot or a video to the pull request.
- Sign off each commit, as the next section says.

## License your contribution

tfold is licensed under AGPL-3.0-only. Contributions are accepted under the same license, so what you send in goes out under the same terms.

Sign off each commit with `git commit -s`. The sign-off adds a `Signed-off-by:` line with your name and email. It certifies the [Developer Certificate of Origin](https://developercertificate.org), which says that you have the right to submit the work under this license.

### Files derived from TextFold

Some files come from [TextFold](https://github.com/chenxiachan/textfold), which is licensed under Apache-2.0. `NOTICE` lists them and the TextFold file behind each one. Those files also remain under Apache-2.0, and `LICENSES/Apache-2.0.txt` holds that license.

- Keep the comment at the top of each of those files. It names the TextFold source and the commit, and it says what tfold changed. Apache-2.0 asks for that notice, so add a line when your change is a new kind of change.
- Your change to one of those files is contributed under AGPL-3.0-only, like any other change.
- If you port more code from TextFold, add the file to the list in `NOTICE`, with the same comment at the top.
