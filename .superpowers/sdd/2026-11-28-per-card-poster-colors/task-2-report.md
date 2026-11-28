# Task 2: Active-Card Color Controls — Report

## Status

Implemented and committed as `feat(poster): customize colors per song card`.

## Changes

- Added active-card start, end, and text color controls and a `Reset Warna` action inside the card inspector.
- Controls synchronize from `getCardColors()` when the active card changes; selecting a card does not create color overrides.
- Valid picker and HEX changes are normalized and stored only on the active card. Invalid HEX values do not change the stored color.
- Reset removes only the active card's color overrides, restores global fallback colors in the controls, and rerenders the poster.
- Global color changes refresh the active inspector so inherited values stay current.

## Verification

- `node --test tests/frontend/poster-colors.test.mjs` — passed.
- JavaScript syntax checks (`node --check` over `static/js/*.js` and `static/service-worker.js`) — passed.
- Frontend CI suite (`listening.test.mjs`, `listening-sync.test.mjs`, `player-queue.test.mjs`) — passed, 3 tests.
- Feature-specific Playwright smoke — passed: opened the poster modal, confirmed active-card controls are visible, edited a HEX value, verified per-card isolation, reset to fallback, and observed no browser page errors.
- `node tests/frontend/browser-smoke.mjs` — did not complete: after its repeat and playback checks, it fails at the existing `#eq-popover .eq-toggle-slider` selector because it matches three elements (Playwright strict-mode violation). This failure occurs before the script reaches any poster checks and is unrelated to these changes.

## Concerns

The general browser-smoke script has a pre-existing ambiguous equalizer selector. The feature-specific browser check passed independently. No dependency manifest or unrelated source files were changed.

## Files Changed

- `templates/index.html`
- `static/js/poster.js`
