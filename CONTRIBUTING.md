# Contributing

Thanks for helping improve Forgesite!

## Before you start
- Open an issue to discuss non-trivial changes.
- `index.html` is currently a single file — avoid large formatting-only diffs.

## Patch scripts
- Patches must be **idempotent** (running twice yields the same result).
- Document each patch at the top of the file with a docstring.
- Test against a fresh copy of `index.html`.

## Commit style
Use short imperative subjects: `fix: correct anchor links`, `docs: add README`.

## Pull requests
- Keep PRs focused on one thing.
- CI (HTMLHint) must pass.
