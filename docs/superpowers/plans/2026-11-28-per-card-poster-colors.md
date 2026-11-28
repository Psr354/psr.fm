# Per-Card Poster Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each selected poster song card to override the global gradient and text colors independently.

**Architecture:** Add optional card-level color fields to the existing `cardOverrides` map and resolve effective colors at render time. The active-card inspector will edit those fields; cards without fields continue to use global theme values.

**Tech Stack:** Vanilla JavaScript, HTML, CSS, Node.js test runner.

**Spec:** `docs/superpowers/specs/2026-11-28-per-card-poster-colors-design.md`

## Global Constraints

- Card colors remain browser-local; no backend or database storage.
- HEX values must be exactly `#` plus six hexadecimal digits.
- Global themes remain the fallback for cards without overrides.
- Existing card size, position, rotation, 3D, and layer behavior must remain unchanged.

## Review Focus

- Card override isolation: changing card A must not change card B or uncustomized cards; cover this in `tests/frontend/poster-colors.test.mjs`.
- Global fallback: a card with no color override must track later global theme changes; cover this in `tests/frontend/poster-colors.test.mjs`.
- Reset behavior: resetting card A must remove only its color override fields and leave position/scale/layer fields intact; cover this in `tests/frontend/poster-colors.test.mjs`.
- Invalid HEX: malformed or partial values must not replace existing colors; cover this in `tests/frontend/poster-colors.test.mjs`.
- Active card removal: selecting a song not present or deselecting the active card must hide the card inspector; cover this in the browser smoke test.

---

### Task 1: Add Per-Card Color Resolution and Rendering

**Files:**
- Modify: `static/js/poster.js`
- Test: `tests/frontend/poster-colors.test.mjs`

**Interfaces:**
- Consumes: `normalizeHex`, `cardOverrides`, `posterCardStart`, `posterCardEnd`, `posterCardText`
- Produces: `getCardColors(songId) -> { startColor: string, endColor: string, textColor: string }`
- Rendering: `paintCardContent(ctx, song, coverImg, w, h, colors)`

- [ ] **Step 1: Add failing color-resolution tests**

Create `tests/frontend/poster-colors.test.mjs` using Node `assert/strict`, `fs`, and `vm`.

Load a source slice containing `normalizeHex`, `hexToRgba`, `cardOverrides`, and the new card resolution function. Assert:
- `normalizeHex('#12aBef')` and `normalizeHex('  #12ABEF  ')` return `#12ABEF`
- malformed values return `null`
- `getCardColors('1')` returns global values when no override exists
- after setting override fields for card `1`, card `1` uses those values while card `2` uses global values
- resetting card `1` deletes only `startColor`, `endColor`, and `textColor` while preserving `x`, `behindSubject`, and `scaleMul`

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/frontend/poster-colors.test.mjs`
Expected: FAIL because `getCardColors` and reset behavior are not implemented.

- [ ] **Step 3: Implement card color resolution**

In `static/js/poster.js`:
- Extend the `cardOverrides` entry comment to include optional `startColor`, `endColor`, and `textColor`.
- Add `getCardColors(songId)` immediately after the override map declaration.
- Add `resetCardColors(songId)` that deletes only `startColor`, `endColor`, and `textColor` and removes an override entry only if it becomes empty.
- Update `paintCardContent(ctx, song, coverImg, w, h, colors)` to use `colors.startColor`, `colors.endColor`, and `colors.textColor`.
- Update `drawMiniPlayerCard` to accept and forward effective card colors.
- Update `cardsToDraw` to include `colors: getCardColors(sid)`.
- Update card drawing calls to pass `c.colors`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/frontend/poster-colors.test.mjs`
Expected: PASS.

### Task 2: Add Active-Card Color Controls

**Files:**
- Modify: `templates/index.html`
- Modify: `static/js/poster.js`

**Interfaces:**
- Consumes: active `activeCardId`, `cardOverrides`, `normalizeHex`, `getCardColors`
- Produces: active-card start/end/text color controls and reset action

- [ ] **Step 1: Add active-card control markup**

In `templates/index.html`, inside `poster-card-inspector` after the existing sliders:
- Add a `.share-custom-theme` block labeled `Warna Kartu Aktif`.
- Add `id="poster-active-card-start"` color input and `id="poster-active-card-start-hex"` HEX input.
- Add `id="poster-active-card-end"` color input and `id="poster-active-card-end-hex"` HEX input.
- Add `id="poster-active-card-text"` color input.
- Add `id="poster-reset-card-colors-btn"` button with text `Reset Warna`.

- [ ] **Step 2: Wire DOM references and active-card synchronization**

In `static/js/poster.js`:
- Add DOM references for the three pickers, two HEX inputs, and reset button.
- In `updateCardInspector()`, populate these controls from `getCardColors(card.songId)`.
- Do not activate card override fields until a color value is changed.
- Color and HEX inputs must call `normalizeHex` and store the corresponding field on the active card only.
- Text input must store `textColor` for the active card only.
- Reset button must call `resetCardColors(activeCardId)`, refresh controls from global fallback values, and render.

- [ ] **Step 3: Verify markup wiring by browser smoke test**

Run: `node tests/frontend/browser-smoke.mjs`
Expected: The poster modal opens and the active-card controls are present without console errors.

- [ ] **Step 4: Commit implementation**

```bash
git add static/js/poster.js templates/index.html tests/frontend/poster-colors.test.mjs
git commit -m "feat(poster): customize colors per song card"
```
