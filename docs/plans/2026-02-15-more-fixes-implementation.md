# More Fixes & Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 13 issues covering canvas regression, hive management, CRUD gaps, equipment rework, and UI improvements.

**Architecture:** Schema-first approach — add new tables/columns via Drizzle, then implement server actions, then UI components. Bug fixes done first as quick wins.

**Tech Stack:** Next.js 15, React 19, Drizzle ORM, PostgreSQL, Tailwind CSS, shadcn/ui, react-konva

---

## Phase 1: Quick Bug Fixes (Issues #7, #10)

### Task 1: Fix bulk action select-all form submission bug (#7)

**Files:**
- Modify: `src/components/bulk/hive-multi-selector.tsx:85-89`

**Step 1: Fix the All/None buttons**

The "All" and "None" buttons at lines 85-89 are `<Button>` components without `type="button"`, so they default to `type="submit"` inside a form.

In `src/components/bulk/hive-multi-selector.tsx`, change lines 85-89:

```tsx
<Button variant="ghost" size="sm" type="button" onClick={selectAll}>
  All
</Button>
<Button variant="ghost" size="sm" type="button" onClick={selectNone}>
  None
</Button>
```

**Step 2: Also fix the Apply button in range picker**

At line 142, the Apply button also needs `type="button"`:

```tsx
<Button onClick={applyRange} size="sm" type="button">
  Apply
</Button>
```

**Step 3: Verify with type check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/components/bulk/hive-multi-selector.tsx
git commit -m "fix: add type=button to bulk selector buttons to prevent form submission"
```

---

### Task 2: Fix queen form empty string Select bug (#10)

**Files:**
- Modify: `src/components/queens/queen-form.tsx:82,88,122,128,142,148`
- Modify: `src/actions/queens.ts:28,30,31`

**Step 1: Replace empty string values with `__none__` sentinel in queen-form.tsx**

At line 82, change:
```tsx
defaultValue={defaultValues?.hiveId ?? ""}
```
to:
```tsx
defaultValue={defaultValues?.hiveId ?? "__none__"}
```

At line 88, change:
```tsx
<SelectItem value="">None</SelectItem>
```
to:
```tsx
<SelectItem value="__none__">None</SelectItem>
```

At line 122, change:
```tsx
defaultValue={defaultValues?.originHiveId ?? ""}
```
to:
```tsx
defaultValue={defaultValues?.originHiveId ?? "__none__"}
```

At line 128, change:
```tsx
<SelectItem value="">None</SelectItem>
```
to:
```tsx
<SelectItem value="__none__">None</SelectItem>
```

At line 142, change:
```tsx
defaultValue={defaultValues?.parentQueenId ?? ""}
```
to:
```tsx
defaultValue={defaultValues?.parentQueenId ?? "__none__"}
```

At line 148, change:
```tsx
<SelectItem value="">None</SelectItem>
```
to:
```tsx
<SelectItem value="__none__">None</SelectItem>
```

**Step 2: Update queen actions to handle `__none__` sentinel**

In `src/actions/queens.ts`, update `createQueen` (line 28-31):
```ts
hiveId: hiveId && hiveId !== "__none__" ? hiveId : null,
origin: origin as QueenOrigin,
originHiveId: originHiveId && originHiveId !== "__none__" ? originHiveId : null,
parentQueenId: parentQueenId && parentQueenId !== "__none__" ? parentQueenId : null,
```

Also update `updateQueen` (line 66-68) similarly:
```ts
hiveId: hiveId && hiveId !== "__none__" ? hiveId : null,
origin: origin as QueenOrigin,
originHiveId: originHiveId && originHiveId !== "__none__" ? originHiveId : null,
parentQueenId: parentQueenId && parentQueenId !== "__none__" ? parentQueenId : null,
```

**Step 3: Verify with type check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/components/queens/queen-form.tsx src/actions/queens.ts
git commit -m "fix: use __none__ sentinel for queen form select values"
```

---

## Phase 2: Schema Changes (Issues #2, #4, #5, #13)

### Task 3: Add `isArchived` and `deadoutDate` to hives schema (#4, #5)

**Files:**
- Modify: `src/db/schema/hives.ts`

**Step 1: Add columns to hives table**

Add `boolean` and `timestamp` imports, then add the columns:

```ts
import { pgTable, uuid, text, timestamp, pgEnum, boolean } from "drizzle-orm/pg-core";
import { apiaries } from "./apiaries";

export const hiveStatusEnum = pgEnum("hive_status", ["active", "dead", "sold", "combined"]);

export const hives = pgTable("hives", {
  id: uuid("id").defaultRandom().primaryKey(),
  apiaryId: uuid("apiary_id").notNull().references(() => apiaries.id),
  positionLabel: text("position_label").notNull(),
  status: hiveStatusEnum("status").default("active").notNull(),
  installedDate: timestamp("installed_date"),
  isArchived: boolean("is_archived").default(false).notNull(),
  deadoutDate: timestamp("deadout_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

**Step 2: Generate migration**

Run: `npx drizzle-kit generate`

**Step 3: Commit**

```bash
git add src/db/schema/hives.ts drizzle/
git commit -m "feat: add isArchived and deadoutDate columns to hives schema"
```

---

### Task 4: Create hiveSplits schema (#2)

**Files:**
- Create: `src/db/schema/hive-splits.ts`
- Modify: `src/db/schema/index.ts`

**Step 1: Create the hive-splits schema file**

```ts
import { pgTable, uuid, text, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const splitTypeEnum = pgEnum("split_type", ["walk-away", "vertical", "nuc", "cutdown", "other"]);

export const hiveSplits = pgTable("hive_splits", {
  id: uuid("id").defaultRandom().primaryKey(),
  parentHiveId: uuid("parent_hive_id").notNull().references(() => hives.id),
  childHiveId: uuid("child_hive_id").notNull().references(() => hives.id),
  splitDate: timestamp("split_date").notNull(),
  splitType: splitTypeEnum("split_type").notNull(),
  framesMoved: integer("frames_moved"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Step 2: Export from schema index**

Add to `src/db/schema/index.ts`:
```ts
export { hiveSplits, splitTypeEnum } from "./hive-splits";
```

**Step 3: Generate migration**

Run: `npx drizzle-kit generate`

**Step 4: Commit**

```bash
git add src/db/schema/hive-splits.ts src/db/schema/index.ts drizzle/
git commit -m "feat: add hiveSplits schema for split tracking"
```

---

### Task 5: Create equipment rework schema (#13)

**Files:**
- Create: `src/db/schema/equipment-v2.ts`
- Modify: `src/db/schema/index.ts`

**Step 1: Create new equipment schema**

```ts
import { pgTable, uuid, text, timestamp, integer, pgEnum, boolean } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const equipmentCategoryEnum = pgEnum("equipment_category", ["box", "cover", "bottom", "accessory", "other"]);
export const stockAdjustmentReasonEnum = pgEnum("stock_adjustment_reason", ["purchased", "built", "discarded", "broken", "gifted", "other"]);

export const equipmentTypes = pgTable("equipment_types", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  category: equipmentCategoryEnum("category").notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const equipmentStock = pgTable("equipment_stock", {
  id: uuid("id").defaultRandom().primaryKey(),
  typeId: uuid("type_id").notNull().references(() => equipmentTypes.id),
  totalOwned: integer("total_owned").default(0).notNull(),
  storageLocation: text("storage_location"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const equipmentStockAdjustments = pgTable("equipment_stock_adjustments", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull().references(() => equipmentStock.id),
  quantity: integer("quantity").notNull(),
  reason: stockAdjustmentReasonEnum("reason").notNull(),
  notes: text("notes"),
  date: timestamp("date").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const equipmentDeployments = pgTable("equipment_deployments", {
  id: uuid("id").defaultRandom().primaryKey(),
  stockId: uuid("stock_id").notNull().references(() => equipmentStock.id),
  hiveId: uuid("hive_id").notNull().references(() => hives.id),
  quantity: integer("quantity").default(1).notNull(),
  dateDeployed: timestamp("date_deployed").notNull(),
  dateRemoved: timestamp("date_removed"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Step 2: Add exports to schema index**

Add to `src/db/schema/index.ts`:
```ts
export { equipmentTypes, equipmentStock, equipmentStockAdjustments, equipmentDeployments, equipmentCategoryEnum, stockAdjustmentReasonEnum } from "./equipment-v2";
```

**Step 3: Generate migration**

Run: `npx drizzle-kit generate`

**Step 4: Commit**

```bash
git add src/db/schema/equipment-v2.ts src/db/schema/index.ts drizzle/
git commit -m "feat: add equipment v2 schema with types, stock, adjustments, and deployments"
```

---

### Task 6: Add preferences fields to userSettings (#12)

**Files:**
- Modify: `src/db/schema/settings.ts`

**Step 1: Add preference fields**

```ts
import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const userSettings = pgTable("user_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name"),
  aiProviderConfig: jsonb("ai_provider_config"),
  inspectionPreferences: jsonb("inspection_preferences"),
  jarSizes: jsonb("jar_sizes"),
  theme: text("theme").default("system"),
  defaultApiaryId: uuid("default_apiary_id"),
  dateFormat: text("date_format").default("MM/DD/YYYY"),
  weightUnit: text("weight_unit").default("oz"),
  dashboardPreferences: jsonb("dashboard_preferences"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

**Step 2: Generate migration**

Run: `npx drizzle-kit generate`

**Step 3: Commit**

```bash
git add src/db/schema/settings.ts drizzle/
git commit -m "feat: add preference fields to userSettings schema"
```

---

## Phase 3: Archive & Deadout Actions (Issues #4, #5)

### Task 7: Add archive/deadout server actions and update hive queries

**Files:**
- Modify: `src/actions/hives.ts`

**Step 1: Add archive/unarchive/deadout actions**

Add after `deleteHive` function:

```ts
// Archive a hive
export async function archiveHive(id: string) {
  await db
    .update(hives)
    .set({ isArchived: true, updatedAt: new Date() })
    .where(eq(hives.id, id));

  revalidatePath("/hives");
  revalidatePath(`/hives/${id}`);
}

// Unarchive a hive
export async function unarchiveHive(id: string) {
  await db
    .update(hives)
    .set({ isArchived: false, updatedAt: new Date() })
    .where(eq(hives.id, id));

  revalidatePath("/hives");
  revalidatePath(`/hives/${id}`);
}

// Mark as deadout (set dead + archive + record date)
export async function markDeadout(id: string) {
  await db
    .update(hives)
    .set({
      status: "dead",
      isArchived: true,
      deadoutDate: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(hives.id, id));

  revalidatePath("/hives");
  revalidatePath(`/hives/${id}`);
}
```

**Step 2: Update `getHives` to filter archived by default**

Modify `getHives` to accept `includeArchived` parameter:

```ts
export async function getHives(apiaryId?: string, status?: string, includeArchived = false) {
  // ... existing select/from/join ...

  const conditions = [];
  if (!includeArchived) {
    conditions.push(eq(hives.isArchived, false));
  }
  if (apiaryId) {
    conditions.push(eq(hives.apiaryId, apiaryId));
  }
  if (status) {
    conditions.push(eq(hives.status, status as "active" | "dead" | "sold" | "combined"));
  }

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}
```

**Step 3: Verify with type check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/actions/hives.ts
git commit -m "feat: add archive, unarchive, and deadout actions for hives"
```

---

### Task 8: Add archive/deadout UI to hive detail page

**Files:**
- Modify: `src/app/(protected)/hives/[id]/page.tsx`
- Modify: `src/app/(protected)/hives/page.tsx`

**Step 1: Add archive/deadout buttons to hive detail page**

In `src/app/(protected)/hives/[id]/page.tsx`, add import for the actions and add buttons to the quick actions area.

Add to imports:
```ts
import { archiveHive, unarchiveHive, markDeadout } from "@/actions/hives";
import { Archive, ArchiveRestore, Skull } from "lucide-react";
```

Add archive/deadout buttons after the existing quick action buttons (around line 111):

```tsx
{/* Archive/Deadout actions */}
{!hive.isArchived && hive.status === "active" && (
  <>
    <form action={async () => { "use server"; await archiveHive(id); }}>
      <Button variant="outline" size="sm" type="submit">
        <Archive className="h-4 w-4 mr-2" />
        Archive
      </Button>
    </form>
    <form action={async () => { "use server"; await markDeadout(id); }}>
      <Button variant="destructive" size="sm" type="submit">
        <Skull className="h-4 w-4 mr-2" />
        Deadout
      </Button>
    </form>
  </>
)}
{hive.isArchived && (
  <form action={async () => { "use server"; await unarchiveHive(id); }}>
    <Button variant="outline" size="sm" type="submit">
      <ArchiveRestore className="h-4 w-4 mr-2" />
      Unarchive
    </Button>
  </form>
)}
```

Also fetch `isArchived` and `deadoutDate` from `getHive`.

**Step 2: Add "Show Archived" toggle to hives list page**

In `src/app/(protected)/hives/page.tsx`, add a query param `showArchived`:

```tsx
const { apiaryId, status, showArchived } = await searchParams;
const hives = await getHives(apiaryId, status, showArchived === "true");
```

Add a toggle link in the header area.

**Step 3: Verify with type check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/app/(protected)/hives/[id]/page.tsx src/app/(protected)/hives/page.tsx
git commit -m "feat: add archive/deadout UI to hive detail and list pages"
```

---

## Phase 4: CRUD Gaps (Issues #3, #6)

### Task 9: Add delete buttons for queens, feedings, apiaries, and bloom observations

**Files:**
- Modify: `src/components/hives/hive-detail-tabs.tsx` (queen delete, feeding delete)
- Modify: `src/components/inspections/inspection-card.tsx` (add delete button)
- Modify: `src/actions/queens.ts` (add deleteQueen)
- Modify: `src/actions/apiaries.ts` (add deleteApiary)
- Modify: `src/actions/bloom-observations.ts` (add deleteBloomObservation)
- Create: `src/components/shared/delete-button.tsx`

**Step 1: Create a reusable delete button component with AlertDialog**

Create `src/components/shared/delete-button.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";

interface DeleteButtonProps {
  onDelete: () => Promise<void>;
  entityName: string;
  warning?: string;
  variant?: "ghost" | "destructive" | "outline";
  size?: "sm" | "default" | "icon";
  iconOnly?: boolean;
}

export function DeleteButton({
  onDelete,
  entityName,
  warning,
  variant = "ghost",
  size = "icon",
  iconOnly = true,
}: DeleteButtonProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} className={iconOnly ? "text-muted-foreground hover:text-destructive" : ""}>
          <Trash2 className="h-4 w-4" />
          {!iconOnly && <span className="ml-2">Delete</span>}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {entityName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {warning || `This will permanently delete this ${entityName.toLowerCase()}. This action cannot be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={async () => {
              setIsDeleting(true);
              await onDelete();
              setIsDeleting(false);
            }}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

**Step 2: Add deleteQueen action**

Add to `src/actions/queens.ts`:
```ts
export async function deleteQueen(id: string) {
  const queen = await db.select({ hiveId: queens.hiveId }).from(queens).where(eq(queens.id, id)).limit(1);
  await db.delete(queens).where(eq(queens.id, id));
  revalidatePath("/genealogy");
  if (queen[0]?.hiveId) {
    revalidatePath(`/hives/${queen[0].hiveId}`);
  }
}
```

**Step 3: Add delete to inspection card**

In `src/components/inspections/inspection-card.tsx`, add a delete button next to the edit button. Import `DeleteButton` and the `deleteInspection` action.

**Step 4: Add delete to feeding list items**

Update the `FeedingList` component or `hive-detail-tabs.tsx` feedings section to include a delete button per feeding.

**Step 5: Add deleteApiary and deleteBloomObservation actions if missing**

Check if these actions exist; if not, add them.

**Step 6: Verify with type check**

Run: `npx tsc --noEmit`

**Step 7: Commit**

```bash
git add src/components/shared/delete-button.tsx src/actions/queens.ts src/components/inspections/inspection-card.tsx src/components/hives/hive-detail-tabs.tsx
git commit -m "feat: add delete functionality for queens, feedings, inspections, apiaries"
```

---

## Phase 5: Hive Splits (Issue #2)

### Task 10: Create split actions and UI

**Files:**
- Create: `src/actions/hive-splits.ts`
- Create: `src/components/hives/split-hive-form.tsx`
- Create: `src/app/(protected)/hives/[id]/split/page.tsx`
- Modify: `src/components/hives/hive-detail-tabs.tsx` (add Splits tab)
- Modify: `src/app/(protected)/hives/[id]/page.tsx` (add Split button, fetch split data)

**Step 1: Create split actions**

Create `src/actions/hive-splits.ts`:

```ts
"use server";

import { db } from "@/db";
import { hiveSplits, hives, hiveLocationHistory, apiaries } from "@/db/schema";
import { eq, or, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createSplit(_prevState: unknown, formData: FormData) {
  const parentHiveId = formData.get("parentHiveId") as string;
  const apiaryId = formData.get("apiaryId") as string;
  const positionLabel = formData.get("positionLabel") as string;
  const splitDate = formData.get("splitDate") as string;
  const splitType = formData.get("splitType") as string;
  const framesMoved = formData.get("framesMoved") as string;
  const notes = formData.get("notes") as string;

  if (!parentHiveId || !apiaryId || !positionLabel || !splitDate || !splitType) {
    return { error: "Parent hive, apiary, position, date, and split type are required" };
  }

  const result = await db.transaction(async (tx) => {
    // Create child hive
    const [childHive] = await tx.insert(hives).values({
      apiaryId,
      positionLabel: positionLabel.trim(),
      status: "active",
      installedDate: new Date(splitDate),
    }).returning();

    // Create location history for child
    await tx.insert(hiveLocationHistory).values({
      hiveId: childHive.id,
      apiaryId,
      positionLabel: positionLabel.trim(),
      dateFrom: new Date(splitDate),
    });

    // Record the split
    await tx.insert(hiveSplits).values({
      parentHiveId,
      childHiveId: childHive.id,
      splitDate: new Date(splitDate),
      splitType: splitType as "walk-away" | "vertical" | "nuc" | "cutdown" | "other",
      framesMoved: framesMoved ? parseInt(framesMoved) : null,
      notes: notes?.trim() || null,
    });

    return childHive;
  });

  revalidatePath("/hives");
  revalidatePath(`/hives/${parentHiveId}`);
  redirect(`/hives/${result.id}`);
}

export async function getSplitsForHive(hiveId: string) {
  return db
    .select({
      id: hiveSplits.id,
      parentHiveId: hiveSplits.parentHiveId,
      childHiveId: hiveSplits.childHiveId,
      splitDate: hiveSplits.splitDate,
      splitType: hiveSplits.splitType,
      framesMoved: hiveSplits.framesMoved,
      notes: hiveSplits.notes,
    })
    .from(hiveSplits)
    .where(or(eq(hiveSplits.parentHiveId, hiveId), eq(hiveSplits.childHiveId, hiveId)))
    .orderBy(desc(hiveSplits.splitDate));
}

export async function deleteSplit(id: string) {
  await db.delete(hiveSplits).where(eq(hiveSplits.id, id));
  revalidatePath("/hives");
}
```

**Step 2: Create split form component**

Create `src/components/hives/split-hive-form.tsx` — a form with parent hive (hidden), apiary select, position label, split date, split type dropdown, frames moved, notes.

**Step 3: Create split page**

Create `src/app/(protected)/hives/[id]/split/page.tsx` — page that renders the split form.

**Step 4: Add Splits tab to hive detail**

In `src/components/hives/hive-detail-tabs.tsx`, add a "Splits" tab that shows split history for the hive (as parent and as child).

**Step 5: Add "Split Hive" button to hive detail page**

In `src/app/(protected)/hives/[id]/page.tsx`, add a quick action button linking to `/hives/${id}/split`. Also fetch split data.

**Step 6: Verify with type check**

Run: `npx tsc --noEmit`

**Step 7: Commit**

```bash
git add src/actions/hive-splits.ts src/components/hives/split-hive-form.tsx src/app/(protected)/hives/[id]/split/ src/components/hives/hive-detail-tabs.tsx src/app/(protected)/hives/[id]/page.tsx
git commit -m "feat: add hive split tracking with form, actions, and detail tab"
```

---

## Phase 6: Equipment Rework (Issue #13)

### Task 11: Create equipment v2 actions

**Files:**
- Create: `src/actions/equipment-v2.ts`

**Step 1: Create server actions for new equipment system**

The actions should include:
- `getEquipmentTypes()` — list all types
- `createEquipmentType()` — add custom type
- `getEquipmentStock()` — stock with type info and computed available
- `adjustStock()` — create adjustment, update totalOwned
- `getStockAdjustments(stockId)` — history
- `deployEquipment()` — create deployment, check available stock
- `removeDeployment()` — set dateRemoved
- `getDeploymentsForHive(hiveId)` — current and past
- `seedDefaultEquipmentTypes()` — seed pre-defined types

See the design doc for full table shapes and computed values.

**Step 2: Verify with type check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/actions/equipment-v2.ts
git commit -m "feat: add equipment v2 server actions"
```

---

### Task 12: Create equipment v2 UI components

**Files:**
- Create: `src/components/equipment/equipment-stock-card.tsx`
- Create: `src/components/equipment/adjust-stock-dialog.tsx`
- Create: `src/components/equipment/deploy-equipment-dialog.tsx`
- Create: `src/components/equipment/equipment-type-form.tsx`
- Modify: `src/app/(protected)/settings/equipment/page.tsx`
- Modify: `src/components/hives/hive-detail-tabs.tsx` (equipment tab)

**Step 1: Create stock card component**

Shows equipment type name, total owned, deployed count, available in storage, with "Adjust Stock" and "View History" actions.

**Step 2: Create adjust stock dialog**

Modal with quantity input (+/-), reason dropdown, notes, date.

**Step 3: Create deploy equipment dialog**

Modal on hive page to select equipment type, quantity, deploy date.

**Step 4: Update equipment settings page**

Replace the current list view with stock cards grouped by category.

**Step 5: Update hive detail equipment tab**

Show current deployments and deployment history instead of old stack view.

**Step 6: Verify with type check**

Run: `npx tsc --noEmit`

**Step 7: Commit**

```bash
git add src/components/equipment/ src/app/(protected)/settings/equipment/page.tsx src/components/hives/hive-detail-tabs.tsx
git commit -m "feat: add equipment v2 UI with stock cards, adjustment dialog, and deployment dialog"
```

---

## Phase 7: Canvas Fixes (Issue #1)

### Task 13: Debug and fix hive rendering regression

**Files:**
- Modify: `src/components/canvas/stand-group.tsx`
- Modify: `src/components/canvas/canvas-inner.tsx`

**Step 1: Investigate the regression**

The `StandGroup` component at `src/components/canvas/stand-group.tsx:270-284` renders hives via `HiveIndicator`. The `hiveStatusMap` and `hiveLabelMap` are built in `canvas-inner.tsx:182-187`. Check if hives are being passed correctly to the component and if the maps are populated.

Debug by checking:
1. Are hives passed to `CanvasInner` populated?
2. Are stands' slots actually containing hive references?
3. Is the `hiveStatusMap` properly populated?

Common regression causes from commit `3fe3c94` (rotation refactor):
- Stand group rendering might have been broken during rotation changes
- Hive data might not be flowing through properly

Fix the root cause once identified.

**Step 2: Verify hive icons render**

Start dev server and check canvas rendering manually.

**Step 3: Commit**

```bash
git add src/components/canvas/
git commit -m "fix: restore hive rendering in canvas stand slots"
```

---

### Task 14: Add drag-and-drop for hives between slots

**Files:**
- Modify: `src/components/canvas/stand-group.tsx`
- Modify: `src/components/canvas/canvas-inner.tsx`

**Step 1: Make HiveIndicator draggable in edit mode**

In `StandGroup`, make the hive Rect draggable when in edit mode. Add drag event handlers:
- `onDragStart`: Store the source slot info, dim the original
- `onDragMove`: Calculate which slot the hive is over, set highlight state
- `onDragEnd`: If over valid slot, move hive there; otherwise snap back

**Step 2: Add slot highlight state to canvas-inner**

Track `dragOverSlot` state: `{ standId, row, col, canDrop: boolean }`.

Pass highlight callback to StandGroup so slots can render highlight borders:
- Blue: empty slot (can drop)
- Green: slot with 1 hive (will stack, max 2)
- Red: slot with 2 hives (full, cannot drop)

**Step 3: Render highlight rectangles in StandGroup**

In the slot rendering loop, if the slot matches `dragOverSlot`, render an overlay Rect with the appropriate highlight color and a dashed stroke.

**Step 4: Handle drop — update stands state**

On drop, remove hive from source slot and add to target slot. If stacking, auto-assign placement (first = bottom, second = top).

**Step 5: Persist layout changes**

After drag-drop, mark `hasUnsavedChanges = true`.

**Step 6: Verify with type check and manual testing**

Run: `npx tsc --noEmit`

**Step 7: Commit**

```bash
git add src/components/canvas/
git commit -m "feat: add drag-and-drop for hives between slots with highlight feedback"
```

---

## Phase 8: Hive Table View & Preferences (Issues #11, #12)

### Task 15: Add hive table view (#11)

**Files:**
- Create: `src/components/hives/hive-table.tsx`
- Modify: `src/app/(protected)/hives/page.tsx`

**Step 1: Create HiveTable component**

```tsx
"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ... status colors, props interface, sortable columns
```

Columns: Location, Status (badge), Apiary, Installed Date. Clickable rows link to hive detail.

**Step 2: Add view toggle to hives page**

In `src/app/(protected)/hives/page.tsx`, add a client component wrapper with a toggle between card and table view icons. Store preference in localStorage.

**Step 3: Verify with type check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/components/hives/hive-table.tsx src/app/(protected)/hives/page.tsx
git commit -m "feat: add table view for hives list with card/table toggle"
```

---

### Task 16: Create preferences page (#12)

**Files:**
- Create: `src/app/(protected)/settings/preferences/page.tsx`
- Create: `src/actions/preferences.ts`

**Step 1: Create preferences actions**

```ts
"use server";

import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function getPreferences() {
  const result = await db.select().from(userSettings).limit(1);
  return result[0] || null;
}

export async function updatePreferences(_prevState: unknown, formData: FormData) {
  const theme = formData.get("theme") as string;
  const defaultApiaryId = formData.get("defaultApiaryId") as string;
  const dateFormat = formData.get("dateFormat") as string;
  const weightUnit = formData.get("weightUnit") as string;

  const existing = await db.select().from(userSettings).limit(1);
  if (!existing[0]) return { error: "No settings found" };

  await db.update(userSettings).set({
    theme: theme || "system",
    defaultApiaryId: defaultApiaryId && defaultApiaryId !== "__none__" ? defaultApiaryId : null,
    dateFormat: dateFormat || "MM/DD/YYYY",
    weightUnit: weightUnit || "oz",
    updatedAt: new Date(),
  }).where(eq(userSettings.id, existing[0].id));

  revalidatePath("/settings/preferences");
  return { success: true };
}
```

**Step 2: Create preferences page**

Form with selects for theme, default apiary, date format, weight unit. Uses `useActionState` pattern.

**Step 3: Verify with type check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/app/(protected)/settings/preferences/ src/actions/preferences.ts
git commit -m "feat: add user preferences page with theme, date format, and weight unit settings"
```

---

## Phase 9: Hive Location Restructure (Issue #8, #9)

### Task 17: Update hive forms with location from layout

**Files:**
- Modify: `src/components/hives/hive-form.tsx` (or wherever the hive create/edit form is)
- Modify: `src/actions/hives.ts`

**Step 1: Add location fields to hive form**

Replace free-text "Position Label" input with:
- Stand dropdown (populated from apiary layout)
- Slot dropdown (populated from selected stand's grid)
- Placement checkboxes (top/bottom/left/right, default none = full)

Auto-generate positionLabel from stand+slot+placement.

**Step 2: Update hive actions to handle structured location**

The `createHive` and `updateHive` actions should accept the structured fields and compute positionLabel.

**Step 3: Verify with type check**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/components/hives/ src/actions/hives.ts
git commit -m "feat: replace position label with structured location from layout"
```

---

### Task 18: Add edit-from-layout modal (#9)

**Files:**
- Create: `src/components/canvas/hive-edit-modal.tsx`
- Modify: `src/components/canvas/canvas-inner.tsx`
- Modify: `src/components/canvas/hive-context-menu.tsx`

**Step 1: Create hive edit modal component**

A shadcn Dialog rendered as HTML over the canvas. Shows current location, status dropdown, placement checkboxes, notes. Save updates both DB and canvas layout.

**Step 2: Add "Edit Hive" to context menu**

In `hive-context-menu.tsx`, add an "Edit" option that opens the modal.

**Step 3: Wire modal into canvas-inner**

Add modal state to `canvas-inner.tsx`. When "Edit Hive" is clicked from context menu, open the modal with the hive data.

**Step 4: Verify with type check**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/components/canvas/
git commit -m "feat: add edit hive modal from canvas layout context menu"
```

---

## Execution Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-2 | Quick bug fixes (#7, #10) |
| 2 | 3-6 | Schema changes (#2, #4, #5, #12, #13) |
| 3 | 7-8 | Archive & deadout actions + UI (#4, #5) |
| 4 | 9 | CRUD gaps — delete buttons (#3, #6) |
| 5 | 10 | Hive splits (#2) |
| 6 | 11-12 | Equipment rework (#13) |
| 7 | 13-14 | Canvas fix + drag-and-drop (#1) |
| 8 | 15-16 | Table view + preferences (#11, #12) |
| 9 | 17-18 | Location restructure + edit modal (#8, #9) |

Within each phase, tasks are independent and can run in parallel.
