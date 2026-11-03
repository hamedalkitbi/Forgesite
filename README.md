# Forgesite

> A single-page construction ERP for field-to-office cost certification.
<!-- ^ Replace with your one-line pitch -->

[![HTMLHint](https://github.com/hamedalkitbi/Forgesite/actions/workflows/htmlhint.yml/badge.svg)](https://github.com/hamedalkitbi/Forgesite/actions/workflows/htmlhint.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What it does
Forgesite is a browser-based ERP prototype that helps site engineers track
certified quantities, costs, and approvals from the field to the office.

## Quick start
No build step required.

1. Clone the repo
   ```bash
   git clone https://github.com/hamedalkitbi/Forgesite.git
   cd Forgesite

## Repository layout
| Path | Purpose |
|------|---------|
| `index.html` | The application (single self-contained file) |
| `apply_all.py` | Applies all patches to `index.html` |
| `fix_anchors.py` | Repairs navigation anchor links |
| `.gitignore` | Git ignore rules |

## Patch workflow (historical)

> ⚠️ `apply_all.py` and `fix_anchors.py` target the **pre-refactor**
> single-file layout. They are kept for historical reference and will
> not run cleanly against the current tree — several anchors now live in
> `styles/main.css` and `scripts/app.js`. Do not run them without
> inspecting the source first.
>
> The current app is already in its patched state. These scripts document
> how it got there, not how to change it going forward.
