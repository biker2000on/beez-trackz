# Mobile responsiveness review — 2026-09-05

Method: every navigable page (39) and every form/dialog reachable from a
page-level button (24) was loaded on production (`atlas.gentlebeeapiary.com`,
image `d81d276`) in an emulated 390×664 phone viewport, and measured
mechanically — content wider than the viewport, elements pushed past its
right edge, tap targets under 40px, text fields under 16px, dialog height
against the screen — then the worst cases were inspected by screenshot.
The operator's summary was "it fairly sucks, especially forms". The
measurements agree, and most of it traces to four causes in shared code
rather than to individual screens.

## 1. What was wrong, in order of damage

### C1. Primary buttons pushed off the screen (13 pages)

Any page whose content included a ledger table grew to the table's natural
width — `/production/harvests` measured 643px inside a 358px column,
`/sales/expenses` 441px — because CSS grid items default to
`min-width: auto`, so the table wrapper's `overflow-x-auto` never got a
chance to scroll. The page did not scroll sideways either (the shell clips),
so the header row's right-aligned actions simply vanished: **Record**, **New
session**, **New harvest**, **New harvest lot**, **Add expense**, **Add
varietal**, **Add product**, **Physical count**, **Add jar size**, and the
lot/session detail actions were all unreachable on a phone. This is the
single biggest reason forms "did not work": the buttons that open them were
not on the screen.

### C2. Every text field zoomed the page on iOS (34 of 36 forms)

Inputs, selects and textareas rendered at 14px. iOS Safari zooms the page
when a field under 16px is focused, and does not zoom back out, so every
form left the operator panned and zoomed after the first tap. Fields were
also 36px tall next to 44px buttons.

### C3. Dialogs were floating cards on a phone (all 24)

The dialog was a centered card with `max-height: calc(100dvh − 2rem)`,
rounded, with an internal scroll. On a phone that meant a 632px card in a
664px viewport with 12–29 fields scrolling inside it, the sticky footer's
safe-area padding letting the scrolled content peek out beneath the buttons,
and the keyboard covering the lower third with nowhere for the sheet to go.
(Screenshot: *Record a sale*, 29 fields, "e.g. Farmers mai" truncated in a
two-column row.)

### C4. Multi-column rows with no phone breakpoint

Three forms used `grid-cols-3` / `grid-cols-4` with no `sm:` prefix (hive
form, product batch, canvas dialog), giving 100px fields on a phone. Most
other rows already collapse (`sm:grid-cols-*`).

### Smaller findings

- **Inline-edit tables** (Operation setup › Jar sizes: 34 sub-44px fields,
  overflow 809px; Varietals: 7) squeeze their first input to 36px ("H",
  "Pi") and clip the rest with no scroll hint.
- **Queens ledger** overflows to 681px with no visible scroll affordance.
- **Tiny inline links**: the hive-name links inside Today / Yard queue cards
  are 18×18px (13 per screen); the workbench's apiary and jar-size links
  are 18px tall.
- **Market day** steppers were flagged at 44×44 but disabled (0 sellable),
  which is the reservation problem from the workflow review, not a layout
  one.
- **Today** on the phone is a 26,000px scroll (workflow review, R1).

## 2. What was fixed (this commit)

All four causes are fixed in shared code, so every page and dialog gets
them without per-screen work:

| Cause | Fix | Where |
|---|---|---|
| C1 | Grid items may shrink (`.grid > * { min-width: 0 }`); DataGrid and Table wrappers `min-w-0 max-w-full` | `globals.css`, `ui/data-grid.tsx`, `ui/table.tsx` |
| C2 | On coarse-pointer devices every text field, select and combobox is 16px and 44px tall | `globals.css` `@media (pointer: coarse)` |
| C3 | Below `sm` the dialog is a full-screen sheet (inset 0, `h-dvh`, no radius, safe-area top padding); the sticky footer owns the bottom padding so nothing peeks under it | `ui/dialog.tsx` |
| C4 | The three fixed rows collapse below `sm` | hive form, product batch, canvas dialog |

Verified on a 393px Chromium phone profile: the Sales page's widest element
is 377px with the table scrolling inside its 359px wrapper; the lot dialog is
393×727 with 16px/44px fields and its footer flush at the bottom; full
Playwright suite green.

## 3. Still to do (per-screen work)

1. **Inline-edit tables on phones** (jar sizes, varietals, session harvest
   entries): give each row a card layout below `sm` (label as the card
   title, fields stacked), or at least a `min-w-40` on the first input so
   the table scrolls instead of crushing.
2. **Scroll affordance for wide ledgers**: a right-edge fade on the DataGrid
   wrapper when `scrollWidth > clientWidth`, and pin the first column.
3. **Tap targets on inline links**: hive names in Today/Yard cards and the
   workbench's entity links should be `inline-flex min-h-11 items-center`
   on touch, or the whole card row should be the link.
4. **Two-column rows on phones**: `grid-cols-2` rows (date + select) are
   170px each at 390px — fine for dates and short selects, but rows pairing
   a combobox with a placeholder like "e.g. Farmers market" should collapse
   (`sm:grid-cols-2`). Audit the 60-odd `grid-cols-2` rows in dialogs and
   collapse the ones with free-text placeholders.
5. **Keyboard-aware sheets**: with the sheet at `h-dvh`, the focused field
   should scroll into view above the keyboard; add
   `scroll-padding-bottom` equal to the footer height on `DialogContent`.
6. **Today on the phone** is a workflow problem (aggregate per apiary), not
   a layout one — see the workflow review.

Re-run the sweep (`scratchpad/mobile-audit/sweep.mjs` in the session
scratchpad; it needs a QA session cookie) after each of these to confirm the
counts drop.
