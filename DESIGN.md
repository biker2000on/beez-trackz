# Beez Trackz UI system

Beez Trackz is a field tool first: quick to scan in sunlight, usable with one
hand, and dense only where comparison helps a decision.

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
- Motion is brief, functional, and disabled when reduced motion is preferred.

## Layout and responsive behavior

- Desktop uses a persistent sidebar and compact comparison tables.
- Mobile uses a five-item bottom bar, horizontally scrollable tabs, card views,
  sticky bulk toolbars, and safe-area padding.
- Tables that must preserve column comparison scroll horizontally rather than
  crushing content.
- Empty, loading, error, and offline states always include a useful next step.

## Core workflows

- Dashboard: prioritize actionable colony, feeding, harvest, and inventory
  signals; avoid decorative charts.
- Apiary: layout canvas, flora, local forecast/bloom intelligence, bulk
  records, photos, and printable hive tags share one detail workflow.
- Hive: inspection, voice capture, feeding, photo, split, and equipment actions
  stay available above the record tabs.
- Honey: quick ledger actions use memorable keys and all multi-line movements
  are committed once.
- Inventory: owned, deployed, available, and frame capacity are visible before
  stock editing; yearly counts are a single bulk operation.
