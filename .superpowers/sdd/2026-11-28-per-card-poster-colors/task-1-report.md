# Task 1 Report: Per-Card Color Resolution and Rendering

## Status

Implemented per-card poster color resolution and rendering.

## Changes

- `normalizeHex` now accepts only six-digit HEX strings and returns valid values in uppercase.
- Added `getCardColors(songId)` to resolve each card's start, end, and text colors from its overrides, falling back independently to the global poster colors.
- Added `resetCardColors(songId)` to remove only the three color fields and discard the override record only when it has no other fields left.
- Threaded the effective colors through card collection and both behind-/in-front-of-subject drawing paths. Gradients, text, and card controls now use the effective colors.
- Added `tests/frontend/poster-colors.test.mjs` covering normalization, global fallback, isolated per-card overrides, and preserving non-color settings during reset.

## Validation

- Confirmed the focused test failed before implementation, then passed:
  `node --test tests/frontend/poster-colors.test.mjs`
- Ran the frontend test suite once after implementation:
  `node --test tests/frontend/*.test.mjs` — 4 tests passed, 0 failed.
- `git diff --check` passed.

## Self-review

Verified all card paint paths receive `colors`, and no card content paint references the global color variables directly. Reset removes only `startColor`, `endColor`, and `textColor`; existing positioning, scale, and layering overrides remain intact. No additional concerns identified.

## Reviewer Follow-up

- Updated `getCardColors(songId)` to pass each `startColor`, `endColor`, and `textColor` override through `normalizeHex`. Invalid or missing values now fall back independently to their corresponding global color.
- Added focused coverage where a card overrides only `endColor`, confirming `startColor` and `textColor` still use their separate global values. Added malformed truthy overrides for all three fields and confirmed each falls back to its corresponding global.
- Confirmed the malformed-value regression test failed against the old implementation: it returned `red`, `#123`, and `#ffffff;` instead of the three global values.

Covering test command:

```text
node --test tests/frontend/poster-colors.test.mjs
```

Output:

```text
✔ tests/frontend/poster-colors.test.mjs (67.701553ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 79.719867
```
