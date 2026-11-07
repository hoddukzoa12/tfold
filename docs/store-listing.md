# Chrome Web Store listing

This file holds what goes into the Chrome Web Store dashboard. The first upload is the open edition, because the store edition folds nothing until sign-in exists.

## Upload

Upload `tfold-open.zip` from the [latest release](https://github.com/hoddukzoa12/tfold/releases/latest), or make it with `npm run package:open`. The manifest version must be higher than the last upload's.

Before you submit, turn on 2-step verification on the developer account, and run the release through the manual checks of the platform you have not tested.

## Store listing tab

- **Name and summary.** These come from `src/_locales/` in the zip.
- **Category.** Productivity.
- **Languages.** English and Korean.
- **Homepage.** `https://tfold.xyz`
- **Support.** `https://tfold.xyz/en/contact`
- **Screenshots, 1280x800.** `docs/media/tfold-store-fold.png`, `tfold-store-levels.png`, `tfold-store-themes.png` and `tfold-store-popup.png`.
- **Small promo tile, 440x280.** `docs/media/tfold-store-tile.png`.
- **Marquee, 1400x560.** Optional, and not made.

### Description in English

```text
tfold shortens the paragraph under your pointer, right on the page you are reading.

Point at a paragraph, hold Ctrl (Cmd on a Mac) and scroll down, or press Alt+Shift+↓ (⌥⇧↓ on a Mac). The paragraph steps through Full, Brief, Key and Takeaway. Scroll up or press ↑ to bring it back. Each paragraph keeps its own level.

QUICK SUMMARIES
These need no account and no key. tfold makes them inside your browser from the paragraph's own text, and nothing leaves your browser.

AI SUMMARIES
These are optional. Save your own OpenGateway or OpenRouter key in settings. When you fold a paragraph, tfold sends it to that service with some of the paragraphs around it, the page title and the page's headings. The service you got the key from charges your account there. AI summaries can be wrong or miss something, so unfold the paragraph to check what matters.

ALSO
- Fold a run of up to 20 paragraphs together.
- Fold other languages into your own language, with a key.
- Turn tfold off for any site from the toolbar button.

tfold needs no account and has no server of its own. It is open source under AGPL-3.0: https://github.com/hoddukzoa12/tfold
```

### Description in Korean

```text
tfold는 읽고 있는 문단을 그 자리에서 짧게 줄여 줘요.

문단에 포인터를 올리고 Ctrl 키(맥에서는 Cmd 키)를 누른 채 아래로 스크롤하거나 Alt+Shift+↓(맥에서는 ⌥⇧↓)를 누르세요. 문단이 Full, Brief, Key, Takeaway 순서로 짧아져요. 위로 스크롤하거나 ↑를 누르면 다시 길어지고, 문단마다 자기 단계를 기억해요.

빠른 요약
계정도 키도 필요 없어요. 문단의 글로 브라우저 안에서 만들고, 아무것도 브라우저 밖으로 나가지 않아요.

AI 요약
원할 때만 써요. 설정에서 내 OpenGateway 또는 OpenRouter 키를 저장하세요. 문단을 접으면 그 문단과 주변 문단 일부, 페이지 제목과 제목들을 그 서비스로 보내요. 비용은 키를 만든 서비스에서 내 계정으로 청구돼요. AI 요약은 틀리거나 빠뜨릴 수 있으니 중요한 내용은 펼쳐서 확인해 주세요.

그 밖에
- 문단을 최대 20개까지 한꺼번에 접어요.
- 키가 있으면 다른 언어로 된 문단을 내 언어로 접어요.
- 툴바 버튼으로 사이트마다 tfold를 끌 수 있어요.

tfold는 계정이 필요 없고 자체 서버도 없어요. 오픈소스이고 라이선스는 AGPL-3.0이에요: https://github.com/hoddukzoa12/tfold
```

## Privacy tab

**Single purpose.**

```text
Shortens the paragraph the reader points at, in place, on the page they are reading.
```

**Permission justifications.**

| Permission | Justification |
| --- | --- |
| `storage` | Keeps the reader's settings, the sites they turned tfold off for, and their API keys in the browser. |
| `scripting` | Starts the content script in tabs that were already open when tfold was installed, updated or turned back on. Chrome starts content scripts only in pages that load after those moments. |
| Host permissions | The reader chooses which paragraph to fold on any page, so the content script runs on every `http` and `https` page. `apis.opengateway.ai` and `openrouter.ai` receive fold requests only when the reader saved a key for that service. |

**Remote code.** No. Every script is in the zip.

**Data usage.** `SECURITY.md` describes each request. Tick these two:

- **Website content.** With a saved key, a fold sends the paragraph, up to seven neighbors, the page title and the page's headings to the service the reader chose. The page URL is not sent.
- **Authentication information.** The reader's API key stays in the browser, and it leaves only in the `Authorization` header of a request to its own service.

The three certifications at the end are yours to make: no sale of data, no use unrelated to the single purpose, and no use for credit decisions.

**Privacy policy.** `https://tfold.xyz/en/privacy`

## Distribution tab

Free, public, in every region. To check the review result before readers see the item, untick the automatic publish box when you submit. You then have up to 30 days to publish.

## Test instructions tab

tfold needs no account, so the reviewer needs no credentials.

```text
No account or key is needed.
1. Open any article, for example a Wikipedia page.
2. Point at a paragraph, hold Ctrl (Cmd on a Mac) and scroll down. The paragraph shortens. Scroll up to restore it.
3. Click the toolbar button to see the site switch and the shortcuts.
AI summaries need the reader's own API key and are optional.
```
