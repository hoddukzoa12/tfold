# How the README media is built

This directory rebuilds `docs/media/tfold-*`. Nothing here ships in the extension, and `package.json` holds no HyperFrames dependency.

- `demo/` is the page that folds. Its text is original, written for this repository.
- `../../../scripts/capture-media.ts` loads a real extension build in Playwright's Chromium, folds the demo page with a real Control key and wheel events, seeks each morph frame by frame, and writes the footage and the raw stills to `assets/`.
- `hero/` and `film/` are [HyperFrames](https://github.com/heygen-com/hyperframes) projects that compose the footage into the hero GIF and the product video. Their band and pointer are added in editing, and the pointer sits where the real pointer was.
- `stills/` composes the social preview, the README stills and the Chrome Web Store images from the raw stills.
- `README.md` shows the English stills. `README.ko.md` shows `tfold-levels-ko.png` and `tfold-popup-ko.png`.
- `model-lines.json` records the unedited model output of the last live capture, with token counts and an estimate at list price.

## Rebuild

Run this on a Linux machine with Node 22 and ffmpeg, after `npm ci` and `npx playwright install chromium`. The popup shots come from the store edition, and the folds from the open edition, which ignores the Free account the script stores.

```sh
npm run build
npm run build:store
bash docs/media/src/rebuild.sh dist dist-store
```

A rebuild needs no key, because the capture answers each fold request with the lines in `model-lines.json` and fails if the page shows anything else. To ask the model again, set `OPENGATEWAY_API_KEY` and add `--live` as the third argument. That run costs less than a cent at list price, rewrites `model-lines.json`, and changes the text on screen.

The script fetches Pretendard (SIL Open Font License) with `npm pack` into `assets/fonts/`. It keeps fonts, footage and renders out of the repository. The numbers in `film/` and `hero/` assume the capture's fixed timings and pointer positions.
