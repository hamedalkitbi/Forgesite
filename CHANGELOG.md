# Changelog

All notable changes are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

### Added
- PWA: `site.webmanifest`, offline app-shell service worker (`sw.js` with versioned
  caches; navigation network-first, same-origin stale-while-revalidate, pinned CDN
  cache-first, Supabase traffic never cached), generated icon set
  (192/512/maskable/apple-touch) rendered from `icons/icon.svg`
- Meta: description, `theme-color`, `color-scheme`, `viewport-fit=cover`,
  preconnect/dns-prefetch hints, `<noscript>` fallback
- Zero-dependency test tooling: `tools/run-tests.mjs` (30 checks: static assets,
  PWA manifest, headless runtime smoke, pure-helper unit tests, accessibility
  basics, offline shell), `tools/smoke.mjs`, `tools/make-icons.mjs`,
  `tools/lib/cdp.mjs` DevTools-Protocol driver
- `package.json` scripts (`serve`, `test`, `smoke`, `icons`)
- CI workflow (HTMLHint + JS syntax + headless test suite) and a GitHub Pages
  deploy workflow

### Changed
- `index.html` references the manifest/icons and registers the service worker on
  https/localhost (`?nosw=1` opt-out)
- README rewritten: layout, offline behavior, testing, deployment and
  backend/RLS notes

### Fixed
- Removed the `favicon.ico` 404 (SVG app icon now served from `icons/icon.svg`)

## [29.0.0] - 2026-11-03

### Changed
- Extracted inline CSS to `styles/main.css`
- Extracted inline JS to `scripts/app.js`
- `index.html` now references external assets instead of bundling them

### Added
- Project docs: README, LICENSE, CONTRIBUTING, SECURITY
- HTMLHint CI workflow
- Issue and PR templates

### Deprecated
- `apply_all.py` and `fix_anchors.py` marked historical — they target the
  pre-refactor single-file layout and will not run cleanly against the
  current tree

## [28.2] - 2026-11-02
### Changed
- (add your last release notes here)
