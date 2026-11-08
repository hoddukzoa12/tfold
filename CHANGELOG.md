# Changelog

Each release of tfold lists what changed for readers. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-11-08

### Added

- Short lines fold. A paragraph or list item of two words or more counts when it sits in the same column as a long paragraph, so a run of folds no longer breaks around it and a short line translates like any paragraph ([#5](https://github.com/hoddukzoa12/tfold/pull/5)).

### Changed

- **Fold other languages into** your language is on by default. A reader who turned it off keeps it off. With it on, a fold of a paragraph in another language can also send the next paragraphs that need translating, before they are folded ([#7](https://github.com/hoddukzoa12/tfold/pull/7)).
- A short line that needs no translation keeps its words at every level and sends no request ([#5](https://github.com/hoddukzoa12/tfold/pull/5)).

### Fixed

- Text on a picture or a video, captions, table cells, formulas and short link lists stay out of folds, so Ctrl and the wheel still zoom over them ([#5](https://github.com/hoddukzoa12/tfold/pull/5)).

## [0.1.0] - 2026-11-07

The first public release.

### Added

- Fold the paragraph under the pointer in place through Full, Brief, Key and Takeaway, with Ctrl (Cmd on a Mac) and the wheel, or with Alt+Shift and an arrow.
- Fold a run of up to 20 paragraphs together by holding the key and moving the pointer.
- Quick summaries made in the browser, with no account and no key.
- AI summaries with the reader's own OpenGateway or OpenRouter key.
- **Fold other languages into** your language, off by default.
- A switch per site in the toolbar popup, a scroll key setting, and folds that follow a page's dark theme.
- English and Korean in the interface.
- `tfold-open.zip` on each GitHub release, with `LICENSE`, `NOTICE` and `LICENSES/` inside ([#2](https://github.com/hoddukzoa12/tfold/pull/2)).

### Removed

- The `activeTab` permission, which no code used ([#2](https://github.com/hoddukzoa12/tfold/pull/2)).

[Unreleased]: https://github.com/hoddukzoa12/tfold/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/hoddukzoa12/tfold/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/hoddukzoa12/tfold/releases/tag/v0.1.0
