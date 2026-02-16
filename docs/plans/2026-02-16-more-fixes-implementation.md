# More Fixes Implementation Plan

Based on `.prompts/04-fixes again.md` - 11 items across canvas fixes, UI improvements, MCP server, and equipment enhancements.

## User Decisions
- **Stack UI**: Popup dialog when dropping hive on another
- **MCP Scope**: Full CRUD for all entities
- **Frame Model**: Both independent stock tracking + boxes record frame capacity

---

## Phase 1: Canvas Fixes (Items 1-6)

### Task 1.1: Unstacking - Expand hives to full size on move
**Files:** `src/components/canvas/canvas-inner.tsx`
- When a hive is dragged from a stacked slot to a different stand/slot, set both the moved hive and remaining hive(s) back to `placement: "full"`
- Modify `handleHiveDragEnd` to detect when source slot had stacked hives and target is different slot
- After move, update source slot hives to "full" placement and target hive to "full"

### Task 1.2: Hive context menu - Add flip direction and split options
**Files:** `src/components/canvas/hive-context-menu.tsx`, `src/components/canvas/canvas-inner.tsx`
- Add "Flip Direction" option that rotates facing by 180 degrees
- Add "Split Hive" option that creates a new hive as a split from current
- Ensure "Edit Hive" opens the existing hive-edit-modal
- Wire up handlers in canvas-inner.tsx

### Task 1.3: North arrow right-click rotation
**Files:** `src/components/canvas/north-arrow.tsx`, `src/components/canvas/canvas-inner.tsx`
- Add right-click context menu on north arrow with rotation options (0, 45, 90, 135, 180, 225, 270, 315)
- Or allow free rotation via right-click + drag

### Task 1.4: Slot right-click - Add hive option
**Files:** `src/components/canvas/stand-context-menu.tsx`, `src/components/canvas/canvas-inner.tsx`
- Right-clicking an empty slot should show "Add Hive Here" option
- Creates a new hive and places it in that specific slot
- Use existing `createHiveFromCanvas` action

### Task 1.5: Location sync on canvas move
**Files:** `src/components/canvas/canvas-inner.tsx`, `src/actions/canvas.ts`, `src/actions/hives.ts`
- When a hive is moved on canvas, update its location fields (standId, slotRow, slotCol) in the database
- Create a `moveHiveOnCanvas` server action that updates hive location + creates a location history record
- Show location history on hive detail page

### Task 1.6: Stacking dialog on drop
**Files:** `src/components/canvas/canvas-inner.tsx`, new: `src/components/canvas/stack-dialog.tsx`
- When dropping a hive on an occupied slot, show a popup dialog
- Options: "Top/Bottom Split" or "Left/Right Split (Nucs)"
- Dialog sets placement for both hives accordingly
- Cancel returns hive to original position

---

## Phase 2: UI Improvements (Items 7-10)

### Task 2.1: Hive edit as modal on detail page
**Files:** `src/app/(protected)/hives/[id]/page.tsx`, `src/components/hives/hive-edit-modal.tsx` (new)
- Convert edit hive from page navigation to modal dialog
- Add "Delete Hive" button (permanent delete, not just archive) with confirmation
- Reuse form fields from existing edit page

### Task 2.2: Equipment deploy as modal with inventory lookup
**Files:** `src/components/hives/hive-detail-tabs.tsx`, `src/components/hives/equipment-deploy-modal.tsx` (new)
- Replace link to `/settings/equipment/new?hiveId=` with modal
- Modal shows available equipment from inventory (stock with available > 0)
- Select equipment type, quantity, deploy directly

### Task 2.3: Apiaries show active hive count
**Files:** `src/actions/apiaries.ts`, `src/app/(protected)/apiaries/page.tsx`
- Filter out archived and dead-out hives from the count
- Add `where(eq(hives.isArchived, false))` and `isNull(hives.deadoutDate)` to the join

### Task 2.4: Queen genealogy dark mode fix
**Files:** `src/components/queens/queen-node.tsx`
- Add `dark:` variants to all hardcoded light-mode colors
- `text-green-700` → `text-green-700 dark:text-green-400`
- `text-gray-700` → `text-gray-700 dark:text-gray-300`
- `text-red-700` → `text-red-700 dark:text-red-400`
- `text-yellow-700` → `text-yellow-700 dark:text-yellow-400`
- Check canvas controls (zoom, pan) for similar issues

---

## Phase 3: MCP Server (Item 10)

### Task 3.1: Create MCP server with full CRUD
**Files:** New directory `src/mcp/` with server, routes, handlers
- Implement MCP server following Model Context Protocol spec
- Full CRUD for: Hives, Apiaries, Queens, Inspections, Feedings, Harvests, Equipment
- Read operations for: Dashboard stats, Recommendations
- Use existing server actions as the data layer
- Configure as stdio transport for Claude Desktop integration

---

## Phase 4: Equipment Frame Tracking (Item 11)

### Task 4.1: Add frame category and tracking
**Files:** `src/db/schema/equipment-v2.ts`, `src/actions/equipment-v2.ts`, equipment UI components
- Add "frame" category to equipment types enum
- Add `frameCondition` field ("drawn" | "fresh" | null) to equipment stock
- Add `framesPerBox` field to equipment types with category "box"
- Create frame calculator that sums: standalone frame stock + (deployed boxes * framesPerBox)
- UI to record frame condition (drawn vs fresh) when adding frame stock

---

## Execution Order
1. Phase 2 Tasks (UI improvements - quickest wins, independent)
2. Phase 1 Tasks (Canvas fixes - more complex, interdependent)
3. Phase 4 (Equipment frames - schema changes)
4. Phase 3 (MCP Server - largest standalone effort)
