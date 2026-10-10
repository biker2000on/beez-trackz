# Beez Trackz UI system

Beez Trackz manages inventory and apiary inspections: quick to scan in sunlight,
usable with one hand, and dense only where comparison helps a decision.

## Product principles

- Put the next likely action beside the information that motivates it.
- Keep common writes within one page and one confirmation.
- Use progressive disclosure for detail; do not hide primary actions in menus.
- Make every collection manageable in bulk. Selection mode uses `b`, select
  all/clear all uses `x`, and the same actions remain visible on touch devices.
- Make the complete application operable from a keyboard. `Ctrl/⌘ K` opens the
  command palette, `g` plus a navigation key changes sections, `?` shows
  shortcuts, and page actions register mnemonic single-key commands.
- Cache authenticated field reads and queue supported JSON writes in the PWA.
  Always show offline/sync state; replay with stable mutation IDs and surface
  conflicts for explicit retry or discard.

## Visual language

- Warm paper backgrounds, honey-gold action color, and dark forest neutrals.
- Rounded cards organize related information; borders and spacing carry more
  hierarchy than shadows.
- Icons clarify actions but never replace text for a primary workflow.
- Status colors are semantic and always paired with text.
- Controls are at least 44px on coarse-pointer devices and respect safe areas.
  Safe-area insets live in one place: `globals.css` defines `--safe-top`,
  `--safe-right`, `--safe-bottom`, `--safe-left` and the `.pt-safe`/`.pr-safe`/
  `.pb-safe`/`.pl-safe` utilities, plus `--bottom-nav-h` for the mobile bar.
  Components use those tokens; nothing else calls `env(safe-area-inset-*)`.
- Motion is brief, functional, and disabled when reduced motion is preferred.

## Layout and responsive behavior

- Desktop uses a persistent sidebar and compact comparison tables.
- Today, Apiaries, Production, Sales, and Stock are the five primary groups.
  Mobile exposes all five directly, with a sixth Pages control for named
  destinations and Insights/Setup. Use safe-area padding and sticky actions.
- Apiary, hive, lot, bottling run, product batch, and stock records have full
  URLs. Section navigation uses named links, including in the mobile Pages
  sheet. Do not nest record tabs or hide navigation in select inputs.
- Map/list views and same-data filters may change presentation in place.
  Preserve the actual apiary canvas, keyboard controls, and layout editing.
- Tables that must preserve column comparison scroll horizontally rather than
  crushing content.
- Empty, loading, error, and offline states always include a useful next step.

## Core workflows

- Dashboard: prioritize actionable colony, feeding, harvest, and inventory
  signals; avoid decorative charts.
- Apiary: layout canvas, flora, local forecast/bloom intelligence, bulk
  records, photos, and printable hive tags share one detail workflow.
- Visits: voice is primary for both apiary observations and hive inspections.
  Review each hive in place; confirm observations and accepted equipment
  changes atomically, then continue to the next hive. Manual entry uses the
  same domain commands. Missing queen observations remain unknown.
- Recordings and editable drafts persist on the device, partitioned by account.
  Freeze upload identity after an attempt; retry with the same identity. Queued
  writes are pending until a server receipt confirms them. Preserve original
  audio, transcript versions, and observation times during correction/recovery.
- Honey: quick ledger actions use memorable keys and all multi-line movements
  are committed once.
- Inventory: show on hand, reserved, and available for the exact item, unit,
  location, lot, condition, and hive tuple. Holds and unknown counts remain
  explicit. The ledger is the only quantity authority.
- Payment and fulfillment are independent facts. Extraction completion is an
  explicit domain action; remaining stock does not imply an active session.
