# Per-Card Poster Colors Design

## Intent and why

Users need to customize the poster color scheme for each song card independently, rather than applying one start color, end color, and text color to every card.

## Goals

- When a card is selected in the Cards tab, the card inspector controls its gradient start, gradient end, and text color.
- Cards with no override keep using the global theme and text color.
- Changing the global theme does not overwrite an existing per-card override.
- A selected card can return to the global theme and text color.

## Non-goals

- Persist poster settings across page reloads.
- Add per-card opacity; opacity remains a global card setting.
- Change the existing card layout, drag, size, rotation, or 3D controls.

## Constraints

- Keep all state in the existing browser-side poster editor; do not add storage or an API.
- Reuse the existing HEX validation and card override map.
- The existing global theme controls remain the fallback for cards without overrides.
- Invalid HEX input must remain ignored, as it is for the existing global controls.

## Approaches

1. Store separate color fields in each card override. This is the smallest complete implementation and keeps card data together.
2. Maintain a separate card color map. This duplicates state and is harder to reset with existing card overrides.

Approach 1 is selected.

## Build design

- Extend `cardOverrides` entries with optional `startColor`, `endColor`, and `textColor`.
- Resolve one card's colors in `getCardColors(songId)`, falling back to `posterCardStart`, `posterCardEnd`, and `posterCardText`.
- Pass resolved colors into `paintCardContent` and `drawMiniPlayerCard`.
- Add three controls to the active-card inspector: gradient start, gradient end, and text color.
- Add a **Reset Warna** button that deletes only the three color fields for the active card.
- Global theme controls continue to update fallback values and apply immediately to cards without overrides.
