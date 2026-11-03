# Changelog

All notable changes are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

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

## [Unreleased]
### Added
- README, LICENSE, CONTRIBUTING, SECURITY, issue/PR templates
- HTMLHint CI workflow

### Changed
- Extracted inline CSS to `styles/main.css` and inline JS to `scripts/app.js`
- Split `index.html` from monolith into markup + assets

### Deprecated
- `apply_all.py` and `fix_anchors.py` marked historical; they target the
  pre-refactor layout and will not run cleanly against the current tree

## [28.2] - 2026-11-02
### Changed
- (add your last release notes here)
