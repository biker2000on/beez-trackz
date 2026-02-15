# Beez Trackz Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 15 improvement items: bee-themed dark/light theme, canvas stands with grid layout and multi-occupant slots, bulk operations, harvest sessions, honey inventory with jar sizes, apiary recordings, Ollama AI enhancements, flowering species tracker, and miscellaneous fixes.

**Architecture:** Extends existing Next.js 15 App Router + Drizzle ORM + PostgreSQL stack. Theme via CSS custom properties. Canvas stands stored in existing JSONB column. New tables for harvest sessions, honey adjustments, and bloom observations. Reusable multi-hive selector component for all bulk operations.

**Tech Stack:** Next.js 15.1.6, React 19, Drizzle ORM 0.45.1, PostgreSQL, react-konva, next-themes, Tailwind CSS 3.4, TypeScript 5, BullMQ

---

## Phase Overview

| Phase | Description | Tasks |
|-------|-------------|-------|
| 1 | Small Fixes (temperament, record note, bucket feeder) | 1-3 |
| 2 | Theme & Dark Mode | 4-6 |
| 3 | Database Migrations (harvest sessions, honey adjustments, bloom observations) | 7-8 |
| 4 | Harvest Session Restructure | 9-11 |
| 5 | Honey Inventory & Jar Sizes | 12-14 |
| 6 | Canvas Stands & Grid Layout | 15-18 |
| 7 | Multi-Hive Selector & Bulk Operations | 19-22 |
| 8 | Apiary-Level Recordings | 23-24 |
| 9 | Ollama AI Enhancements | 25-26 |
| 10 | Flowering Species Tracker | 27-29 |

---

## Phase 1: Small Fixes

### Task 1: Fix Temperament Labels

**Files:**
- Modify: `src/components/inspections/inspection-form.tsx:52-58`

**Step 1: Update the RATING_OPTIONS constant**

In `src/components/inspections/inspection-form.tsx`, replace lines 52-58:

```typescript
const TEMPERAMENT_OPTIONS = [
  { value: "1", label: "1 - Very Aggressive" },
  { value: "2", label: "2 - Aggressive" },
  { value: "3", label: "3 - Moderate" },
  { value: "4", label: "4 - Calm" },
  { value: "5", label: "5 - Very Calm" },
];
```

Keep `RATING_OPTIONS` as-is for honey stores and pollen stores. Only temperament uses the new `TEMPERAMENT_OPTIONS`.

**Step 2: Update the temperament Select to use TEMPERAMENT_OPTIONS**

In the same file, find the temperament `<Select>` (around line 204-222) and change `RATING_OPTIONS` to `TEMPERAMENT_OPTIONS`:

```tsx
<div className="space-y-2">
  <Label htmlFor="temperament">Temperament</Label>
  <Select
    name="temperament"
    defaultValue={
      defaultValues?.temperament?.toString() || "__none__"
    }
  >
    <SelectTrigger>
      <SelectValue placeholder="1-5" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="__none__">Not rated</SelectItem>
      {TEMPERAMENT_OPTIONS.map((opt) => (
        <SelectItem key={opt.value} value={opt.value}>
          {opt.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
</div>
```

**Step 3: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add src/components/inspections/inspection-form.tsx
git commit -m "fix: update temperament labels to aggression scale (Very Aggressive → Very Calm)"
```

---

### Task 2: Replace Record Note with Quick Inspection

**Files:**
- Modify: `src/app/(protected)/hives/[id]/page.tsx:93-99`
- Create: `src/app/(protected)/hives/[id]/inspections/quick/page.tsx`

**Step 1: Replace the Record Note button**

In `src/app/(protected)/hives/[id]/page.tsx`, replace the "Record Note" button (lines 94-99):

```tsx
<Button variant="outline" size="sm" asChild>
  <Link href={`/hives/${id}/inspections/quick`}>
    <ClipboardList className="h-4 w-4 mr-2" />
    Quick Inspection
  </Link>
</Button>
```

Also remove the `StickyNote` import from the lucide-react import line since it's no longer used.

**Step 2: Create the Quick Inspection page**

Create `src/app/(protected)/hives/[id]/inspections/quick/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { getHive } from "@/actions/hives";
import { InspectionForm } from "@/components/inspections/inspection-form";
import { createInspection } from "@/actions/inspections";

export default async function QuickInspectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const hive = await getHive(id);
  if (!hive) notFound();

  return (
    <div className="p-6">
      <InspectionForm
        action={createInspection}
        hiveId={id}
        title={`Quick Inspection — ${hive.positionLabel}`}
        submitLabel="Save Quick Inspection"
      />
    </div>
  );
}
```

This reuses the existing InspectionForm — the user just fills in date + notes and leaves other fields blank. No new component needed.

**Step 3: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add src/app/(protected)/hives/[id]/page.tsx src/app/(protected)/hives/[id]/inspections/quick/page.tsx
git commit -m "fix: replace Record Note (404) with Quick Inspection link"
```

---

### Task 3: Add Bucket Feeder Type

**Files:**
- Modify: `src/db/schema/feedings.ts:5`
- Create: migration SQL via `npx drizzle-kit generate`

**Step 1: Add bucket to the feeder_type enum in schema**

In `src/db/schema/feedings.ts`, update line 5:

```typescript
export const feederTypeEnum = pgEnum("feeder_type", ["entrance", "top", "frame", "baggie", "bucket", "open", "other"]);
```

**Step 2: Generate the Drizzle migration**

Run: `npx drizzle-kit generate`

This creates a new SQL migration file in `./drizzle/`. Verify the generated SQL contains something like:

```sql
ALTER TYPE "feeder_type" ADD VALUE 'bucket';
```

**Step 3: Run the migration**

Run: `npx drizzle-kit push`

Expected: Migration applied successfully.

**Step 4: Verify build**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 5: Commit**

```bash
git add src/db/schema/feedings.ts drizzle/
git commit -m "feat: add bucket feeder type to feeder_type enum"
```

---

## Phase 2: Theme & Dark Mode

### Task 4: Install next-themes and Set Up ThemeProvider

**Files:**
- Modify: `package.json` (install dependency)
- Create: `src/components/theme/theme-provider.tsx`
- Modify: `src/app/layout.tsx`

**Step 1: Install next-themes**

Run: `npm install next-themes`

**Step 2: Create ThemeProvider wrapper**

Create `src/components/theme/theme-provider.tsx`:

```tsx
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
```

**Step 3: Wrap root layout with ThemeProvider**

In `src/app/layout.tsx`, add the import and wrap children:

```tsx
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { ThemeProvider } from '@/components/theme/theme-provider';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Beez Trackz',
  description: 'Self-hosted beekeeping management application',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
```

Note: `suppressHydrationWarning` on `<html>` is required by next-themes to avoid hydration mismatch on the `class` attribute.

**Step 4: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 5: Commit**

```bash
git add package.json package-lock.json src/components/theme/theme-provider.tsx src/app/layout.tsx
git commit -m "feat: install next-themes and add ThemeProvider to root layout"
```

---

### Task 5: Replace CSS Variables with Bee-Themed Colors

**Files:**
- Modify: `src/app/globals.css`

**Step 1: Replace the `:root` and `.dark` CSS variable blocks**

Replace the entire `@layer base` block containing `:root` and `.dark` in `src/app/globals.css` with:

```css
@layer base {
  :root {
    --background: 42 47% 97%;
    --foreground: 25 30% 15%;
    --card: 42 40% 99%;
    --card-foreground: 25 30% 15%;
    --popover: 42 40% 99%;
    --popover-foreground: 25 30% 15%;
    --primary: 43 76% 46%;
    --primary-foreground: 42 47% 97%;
    --secondary: 42 25% 91%;
    --secondary-foreground: 25 30% 25%;
    --muted: 42 20% 93%;
    --muted-foreground: 25 10% 45%;
    --accent: 100 42% 30%;
    --accent-foreground: 42 47% 97%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 98%;
    --border: 35 20% 82%;
    --input: 35 20% 82%;
    --ring: 43 76% 46%;
    --chart-1: 43 76% 46%;
    --chart-2: 100 42% 30%;
    --chart-3: 25 50% 36%;
    --chart-4: 35 80% 56%;
    --chart-5: 15 60% 45%;
    --radius: 0.5rem;
  }
  .dark {
    --background: 25 30% 7%;
    --foreground: 35 30% 90%;
    --card: 25 25% 10%;
    --card-foreground: 35 30% 90%;
    --popover: 25 25% 10%;
    --popover-foreground: 35 30% 90%;
    --primary: 43 80% 55%;
    --primary-foreground: 25 30% 7%;
    --secondary: 25 20% 16%;
    --secondary-foreground: 35 30% 85%;
    --muted: 25 15% 16%;
    --muted-foreground: 35 15% 60%;
    --accent: 100 35% 35%;
    --accent-foreground: 35 30% 90%;
    --destructive: 0 63% 31%;
    --destructive-foreground: 0 0% 98%;
    --border: 25 15% 18%;
    --input: 25 15% 18%;
    --ring: 43 80% 55%;
    --chart-1: 43 80% 55%;
    --chart-2: 100 35% 40%;
    --chart-3: 35 50% 45%;
    --chart-4: 15 70% 50%;
    --chart-5: 25 40% 50%;
  }
}
```

These HSL values create:
- **Light:** Warm cream background, dark brown text, amber/gold primary, forest green accent
- **Dark:** Deep brown/charcoal background, warm cream text, brighter gold primary, forest green accent
- **Charts:** Gold, forest green, brown, amber, terracotta series

**Step 2: Verify dev server renders correctly**

Run: `npm run dev` and visually check the app loads with warm tones.

**Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "feat: replace default gray theme with bee-themed earth tone colors"
```

---

### Task 6: Add Dark Mode Toggle

**Files:**
- Create: `src/components/theme/theme-toggle.tsx`
- Modify: `src/components/nav/sidebar.tsx` (add toggle to sidebar)

**Step 1: Create the theme toggle component**

Create `src/components/theme/theme-toggle.tsx`:

```tsx
"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="h-8 w-8" disabled>
        <Sun className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </Button>
  );
}
```

**Step 2: Add ThemeToggle to the sidebar**

Find the sidebar component at `src/components/nav/sidebar.tsx`. Add the import and place `<ThemeToggle />` in the sidebar header area (near the top, next to the app title or logo). The exact placement depends on the sidebar structure — place it inline with the sidebar header.

```tsx
import { ThemeToggle } from "@/components/theme/theme-toggle";

// In the sidebar header area:
<div className="flex items-center justify-between p-4">
  <span className="font-bold text-lg">Beez Trackz</span>
  <ThemeToggle />
</div>
```

**Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 4: Commit**

```bash
git add src/components/theme/theme-toggle.tsx src/components/nav/sidebar.tsx
git commit -m "feat: add dark mode toggle to sidebar"
```

---

## Phase 3: Database Migrations

### Task 7: Create New Database Tables (harvest_sessions, honey_adjustments, bloom_observations)

**Files:**
- Create: `src/db/schema/harvest-sessions.ts`
- Create: `src/db/schema/honey-adjustments.ts`
- Create: `src/db/schema/bloom-observations.ts`
- Modify: `src/db/schema/index.ts`

**Step 1: Create harvest_sessions schema**

Create `src/db/schema/harvest-sessions.ts`:

```typescript
import { pgTable, uuid, text, timestamp, doublePrecision } from "drizzle-orm/pg-core";
import { apiaries } from "./apiaries";

export const harvestSessions = pgTable("harvest_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  apiaryId: uuid("apiary_id").notNull().references(() => apiaries.id),
  date: timestamp("date").notNull(),
  totalExtractedWeight: doublePrecision("total_extracted_weight"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Step 2: Create honey_adjustments schema**

Create `src/db/schema/honey-adjustments.ts`:

```typescript
import { pgTable, uuid, text, timestamp, doublePrecision, pgEnum } from "drizzle-orm/pg-core";

export const adjustmentTypeEnum = pgEnum("adjustment_type", ["jarring_loss", "other"]);

export const honeyAdjustments = pgTable("honey_adjustments", {
  id: uuid("id").defaultRandom().primaryKey(),
  date: timestamp("date").notNull(),
  type: adjustmentTypeEnum("type").notNull(),
  amountLbs: doublePrecision("amount_lbs").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Step 3: Create bloom_observations schema**

Create `src/db/schema/bloom-observations.ts`:

```typescript
import { pgTable, uuid, text, timestamp, integer, date } from "drizzle-orm/pg-core";
import { apiaries } from "./apiaries";

export const bloomObservations = pgTable("bloom_observations", {
  id: uuid("id").defaultRandom().primaryKey(),
  apiaryId: uuid("apiary_id").notNull().references(() => apiaries.id),
  species: text("species").notNull(),
  dateFirstSeen: date("date_first_seen").notNull(),
  dateLastSeen: date("date_last_seen"),
  year: integer("year").notNull(),
  abundance: integer("abundance"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Step 4: Export from schema index**

Add to `src/db/schema/index.ts`:

```typescript
export { harvestSessions } from "./harvest-sessions";
export { honeyAdjustments, adjustmentTypeEnum } from "./honey-adjustments";
export { bloomObservations } from "./bloom-observations";
```

**Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 6: Commit**

```bash
git add src/db/schema/harvest-sessions.ts src/db/schema/honey-adjustments.ts src/db/schema/bloom-observations.ts src/db/schema/index.ts
git commit -m "feat: add schema for harvest_sessions, honey_adjustments, bloom_observations"
```

---

### Task 8: Add sessionId to honey_harvests and Run Migrations

**Files:**
- Modify: `src/db/schema/honey.ts`
- Generate and run migration

**Step 1: Add sessionId and equipmentId to honey_harvests**

In `src/db/schema/honey.ts`, add imports and columns:

```typescript
import { pgTable, uuid, text, timestamp, doublePrecision, integer, jsonb } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { harvestSessions } from "./harvest-sessions";
import { equipment } from "./equipment";

export const honeyHarvests = pgTable("honey_harvests", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => harvestSessions.id),
  hiveId: uuid("hive_id").notNull().references(() => hives.id),
  equipmentId: uuid("equipment_id").references(() => equipment.id),
  date: timestamp("date").notNull(),
  superWeightBefore: doublePrecision("super_weight_before").notNull(),
  superWeightAfter: doublePrecision("super_weight_after").notNull(),
  calculatedHoneyWeight: doublePrecision("calculated_honey_weight").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const honeyInventory = pgTable("honey_inventory", {
  id: uuid("id").defaultRandom().primaryKey(),
  jarSize: text("jar_size").notNull(),
  jarSizeLabel: text("jar_size_label"),
  honeyOz: doublePrecision("honey_oz"),
  quantity: integer("quantity").notNull(),
  harvestId: uuid("harvest_id").references(() => honeyHarvests.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const honeySales = pgTable("honey_sales", {
  id: uuid("id").defaultRandom().primaryKey(),
  date: timestamp("date").notNull(),
  customerName: text("customer_name"),
  items: jsonb("items").notNull(),
  totalAmount: doublePrecision("total_amount").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Step 2: Generate migration**

Run: `npx drizzle-kit generate`

**Step 3: Run migration**

Run: `npx drizzle-kit push`

**Step 4: Verify build**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 5: Commit**

```bash
git add src/db/schema/honey.ts drizzle/
git commit -m "feat: add sessionId/equipmentId to harvests, jarSizeLabel/honeyOz to inventory, run migrations"
```

---

## Phase 4: Harvest Session Restructure

### Task 9: Create Harvest Session Server Actions

**Files:**
- Create: `src/actions/harvest-sessions.ts`

**Step 1: Create the server actions file**

Create `src/actions/harvest-sessions.ts`:

```typescript
"use server";

import { db } from "@/db";
import { harvestSessions, honeyHarvests, hives, apiaries, equipment } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createHarvestSession(
  _prevState: unknown,
  formData: FormData
) {
  const apiaryId = formData.get("apiaryId") as string;
  const date = formData.get("date") as string;
  const notes = formData.get("notes") as string;

  if (!apiaryId) return { error: "Apiary is required" };
  if (!date) return { error: "Date is required" };

  const [session] = await db
    .insert(harvestSessions)
    .values({
      apiaryId,
      date: new Date(date),
      notes: notes?.trim() || null,
    })
    .returning();

  revalidatePath("/harvest");
  redirect(`/harvest/sessions/${session.id}`);
}

export async function addHarvestEntry(
  sessionId: string,
  _prevState: unknown,
  formData: FormData
) {
  const hiveId = formData.get("hiveId") as string;
  const equipmentId = formData.get("equipmentId") as string;
  const superWeightBefore = formData.get("superWeightBefore") as string;
  const superWeightAfter = formData.get("superWeightAfter") as string;
  const notes = formData.get("notes") as string;

  if (!hiveId) return { error: "Hive is required" };
  if (!superWeightBefore || !superWeightAfter) return { error: "Both weights are required" };

  const before = parseFloat(superWeightBefore);
  const after = parseFloat(superWeightAfter);
  const honeyWeight = before - after;

  if (honeyWeight < 0) return { error: "Weight before must be greater than weight after" };

  // Get session date
  const session = await db
    .select({ date: harvestSessions.date })
    .from(harvestSessions)
    .where(eq(harvestSessions.id, sessionId))
    .limit(1);

  if (!session[0]) return { error: "Session not found" };

  await db.insert(honeyHarvests).values({
    sessionId,
    hiveId,
    equipmentId: equipmentId && equipmentId !== "__none__" ? equipmentId : null,
    date: session[0].date,
    superWeightBefore: before,
    superWeightAfter: after,
    calculatedHoneyWeight: honeyWeight,
    notes: notes?.trim() || null,
  });

  revalidatePath(`/harvest/sessions/${sessionId}`);
  return { success: true };
}

export async function trueUpHarvestSession(
  sessionId: string,
  _prevState: unknown,
  formData: FormData
) {
  const totalWeight = formData.get("totalExtractedWeight") as string;

  if (!totalWeight) return { error: "Total weight is required" };

  await db
    .update(harvestSessions)
    .set({ totalExtractedWeight: parseFloat(totalWeight) })
    .where(eq(harvestSessions.id, sessionId));

  revalidatePath(`/harvest/sessions/${sessionId}`);
  revalidatePath("/harvest");
  redirect(`/harvest/sessions/${sessionId}`);
}

export async function deleteHarvestEntry(entryId: string, sessionId: string) {
  await db.delete(honeyHarvests).where(eq(honeyHarvests.id, entryId));
  revalidatePath(`/harvest/sessions/${sessionId}`);
}

export async function getHarvestSession(id: string) {
  const session = await db
    .select()
    .from(harvestSessions)
    .where(eq(harvestSessions.id, id))
    .limit(1);

  if (!session[0]) return null;

  const entries = await db
    .select({
      id: honeyHarvests.id,
      hiveId: honeyHarvests.hiveId,
      equipmentId: honeyHarvests.equipmentId,
      superWeightBefore: honeyHarvests.superWeightBefore,
      superWeightAfter: honeyHarvests.superWeightAfter,
      calculatedHoneyWeight: honeyHarvests.calculatedHoneyWeight,
      notes: honeyHarvests.notes,
      hiveName: hives.positionLabel,
    })
    .from(honeyHarvests)
    .innerJoin(hives, eq(honeyHarvests.hiveId, hives.id))
    .where(eq(honeyHarvests.sessionId, id))
    .orderBy(honeyHarvests.createdAt);

  const calculatedTotal = entries.reduce((sum, e) => sum + e.calculatedHoneyWeight, 0);

  return {
    ...session[0],
    entries,
    calculatedTotal,
    difference: session[0].totalExtractedWeight
      ? calculatedTotal - session[0].totalExtractedWeight
      : null,
  };
}

export async function getHarvestSessions() {
  return db
    .select({
      id: harvestSessions.id,
      date: harvestSessions.date,
      totalExtractedWeight: harvestSessions.totalExtractedWeight,
      notes: harvestSessions.notes,
      apiaryName: apiaries.name,
      entryCount: sql<number>`cast(count(${honeyHarvests.id}) as integer)`,
      calculatedTotal: sql<number>`coalesce(sum(${honeyHarvests.calculatedHoneyWeight}), 0)`,
    })
    .from(harvestSessions)
    .innerJoin(apiaries, eq(harvestSessions.apiaryId, apiaries.id))
    .leftJoin(honeyHarvests, eq(honeyHarvests.sessionId, harvestSessions.id))
    .groupBy(harvestSessions.id, apiaries.name)
    .orderBy(desc(harvestSessions.date));
}
```

**Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 3: Commit**

```bash
git add src/actions/harvest-sessions.ts
git commit -m "feat: add harvest session server actions (create, add entry, true-up)"
```

---

### Task 10: Create Harvest Session UI Pages

**Files:**
- Create: `src/app/(protected)/harvest/sessions/new/page.tsx`
- Create: `src/app/(protected)/harvest/sessions/[id]/page.tsx`
- Create: `src/components/honey/harvest-session-form.tsx`
- Create: `src/components/honey/harvest-entry-form.tsx`

**Step 1: Create the new session form component**

Create `src/components/honey/harvest-session-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Apiary {
  id: string;
  name: string;
}

interface HarvestSessionFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  apiaries: Apiary[];
}

export function HarvestSessionForm({ action, apiaries }: HarvestSessionFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader>
        <CardTitle>New Harvest Session</CardTitle>
      </CardHeader>
      <CardContent>
        {errorMessage && (
          <p className="text-destructive text-sm mb-4">{errorMessage}</p>
        )}
        <form action={formAction} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="apiaryId">Apiary *</Label>
            <Select name="apiaryId" required>
              <SelectTrigger>
                <SelectValue placeholder="Select apiary" />
              </SelectTrigger>
              <SelectContent>
                {apiaries.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="date">Harvest Date *</Label>
            <Input
              id="date"
              name="date"
              type="date"
              required
              defaultValue={new Date().toISOString().split("T")[0]}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" rows={3} placeholder="Session notes..." />
          </div>
          <Button type="submit" disabled={isPending} className="w-full">
            {isPending ? "Creating..." : "Start Harvest Session"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

**Step 2: Create the harvest entry form component**

Create `src/components/honey/harvest-entry-form.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface Hive {
  id: string;
  positionLabel: string;
}

interface HarvestEntryFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  hives: Hive[];
}

export function HarvestEntryForm({ action, hives }: HarvestEntryFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const [weightBefore, setWeightBefore] = useState("");
  const [weightAfter, setWeightAfter] = useState("");

  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  const honey =
    weightBefore && weightAfter
      ? Math.max(0, parseFloat(weightBefore) - parseFloat(weightAfter))
      : 0;

  return (
    <form action={formAction} className="space-y-4 border rounded-lg p-4">
      {errorMessage && (
        <p className="text-destructive text-sm">{errorMessage}</p>
      )}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Hive *</Label>
          <Select name="hiveId" required>
            <SelectTrigger>
              <SelectValue placeholder="Select hive" />
            </SelectTrigger>
            <SelectContent>
              {hives.map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.positionLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Super (optional)</Label>
          <Select name="equipmentId">
            <SelectTrigger>
              <SelectValue placeholder="Any super" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Not tracked</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>Weight Before (lbs) *</Label>
          <Input
            name="superWeightBefore"
            type="number"
            step="0.1"
            required
            value={weightBefore}
            onChange={(e) => setWeightBefore(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Weight After (lbs) *</Label>
          <Input
            name="superWeightAfter"
            type="number"
            step="0.1"
            required
            value={weightAfter}
            onChange={(e) => setWeightAfter(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Honey</Label>
          <div className="h-10 flex items-center">
            <Badge variant="secondary">{honey.toFixed(1)} lbs</Badge>
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <Label>Notes</Label>
        <Textarea name="notes" rows={2} placeholder="Entry notes..." />
      </div>
      <Button type="submit" disabled={isPending} size="sm">
        {isPending ? "Adding..." : "Add Entry"}
      </Button>
    </form>
  );
}
```

**Step 3: Create the new session page**

Create `src/app/(protected)/harvest/sessions/new/page.tsx`:

```tsx
import { getApiaries } from "@/actions/apiaries";
import { createHarvestSession } from "@/actions/harvest-sessions";
import { HarvestSessionForm } from "@/components/honey/harvest-session-form";

export default async function NewHarvestSessionPage() {
  const apiaries = await getApiaries();

  return (
    <div className="p-6">
      <HarvestSessionForm
        action={createHarvestSession}
        apiaries={apiaries.map((a) => ({ id: a.id, name: a.name }))}
      />
    </div>
  );
}
```

**Step 4: Create the session detail page**

Create `src/app/(protected)/harvest/sessions/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { getHarvestSession, addHarvestEntry, trueUpHarvestSession } from "@/actions/harvest-sessions";
import { getHivesForApiary } from "@/actions/hives";
import { HarvestEntryForm } from "@/components/honey/harvest-entry-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrueUpForm } from "@/components/honey/true-up-form";

export default async function HarvestSessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getHarvestSession(id);
  if (!session) notFound();

  const hives = await getHivesForApiary(session.apiaryId);

  const addEntryAction = addHarvestEntry.bind(null, id);
  const trueUpAction = trueUpHarvestSession.bind(null, id);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Harvest Session</h1>
        <p className="text-muted-foreground">
          {new Date(session.date).toLocaleDateString()}
          {session.notes && ` — ${session.notes}`}
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Calculated Total</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{session.calculatedTotal.toFixed(1)} lbs</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Actual Extracted</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {session.totalExtractedWeight
                ? `${session.totalExtractedWeight.toFixed(1)} lbs`
                : "Not set"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Wax/Losses</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {session.difference != null
                ? `${session.difference.toFixed(1)} lbs`
                : "—"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Entries */}
      <Card>
        <CardHeader>
          <CardTitle>Entries ({session.entries.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {session.entries.length > 0 && (
            <div className="space-y-2 mb-4">
              {session.entries.map((entry) => (
                <div key={entry.id} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div>
                    <span className="font-medium">{entry.hiveName}</span>
                    {entry.notes && <span className="text-muted-foreground ml-2 text-sm">{entry.notes}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {entry.superWeightBefore} → {entry.superWeightAfter}
                    </span>
                    <Badge variant="secondary">{entry.calculatedHoneyWeight.toFixed(1)} lbs</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
          <HarvestEntryForm
            action={addEntryAction}
            hives={hives.map((h) => ({ id: h.id, positionLabel: h.positionLabel }))}
          />
        </CardContent>
      </Card>

      {/* True-up */}
      <TrueUpForm
        action={trueUpAction}
        currentTotal={session.calculatedTotal}
        currentTrueUp={session.totalExtractedWeight}
      />
    </div>
  );
}
```

**Step 5: Create the TrueUpForm component**

Create `src/components/honey/true-up-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TrueUpFormProps {
  action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  currentTotal: number;
  currentTrueUp: number | null;
}

export function TrueUpForm({ action, currentTotal, currentTrueUp }: TrueUpFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const errorMessage =
    state && typeof state === "object" && "error" in state
      ? (state as { error: string }).error
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>True-Up: Actual Extracted Weight</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">
          Calculated sum from entries: <strong>{currentTotal.toFixed(1)} lbs</strong>.
          Enter the actual weight after filtering and settling to account for wax and losses.
        </p>
        {errorMessage && (
          <p className="text-destructive text-sm mb-4">{errorMessage}</p>
        )}
        <form action={formAction} className="flex items-end gap-4">
          <div className="space-y-2 flex-1">
            <Label htmlFor="totalExtractedWeight">Actual Total Weight (lbs)</Label>
            <Input
              id="totalExtractedWeight"
              name="totalExtractedWeight"
              type="number"
              step="0.1"
              required
              defaultValue={currentTrueUp?.toString() ?? ""}
              placeholder="e.g. 45.5"
            />
          </div>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : "Save True-Up"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

**Step 6: Verify build**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 7: Commit**

```bash
git add src/app/(protected)/harvest/sessions/ src/components/honey/harvest-session-form.tsx src/components/honey/harvest-entry-form.tsx src/components/honey/true-up-form.tsx
git commit -m "feat: add harvest session UI (new session, entries, true-up)"
```

---

### Task 11: Wire Harvest Page to Show Sessions

**Files:**
- Modify: `src/app/(protected)/harvest/page.tsx` (or wherever the harvest list page is)

**Step 1: Find and update the harvest list page**

Find the harvest page (likely `src/app/(protected)/harvest/page.tsx`). Add a "New Harvest Session" button linking to `/harvest/sessions/new` and display the sessions list from `getHarvestSessions()`.

The existing per-hive harvest entries should still display (backward compat), but the new "Sessions" section appears at the top. The existing `createHarvest` action in `src/actions/honey.ts` continues to work for legacy single entries.

**Step 2: Verify build and test**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/app/(protected)/harvest/
git commit -m "feat: wire harvest page to display sessions with link to create new"
```

---

## Phase 5: Honey Inventory & Jar Sizes

### Task 12: Add Jar Size Settings

**Files:**
- Create: `src/actions/jar-sizes.ts`
- Create: `src/app/(protected)/settings/jar-sizes/page.tsx`
- Create: `src/components/settings/jar-size-settings.tsx`
- Modify: `src/app/(protected)/settings/page.tsx` (add link)

**Step 1: Create jar size actions**

Create `src/actions/jar-sizes.ts`:

```typescript
"use server";

import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { revalidatePath } from "next/cache";

export interface JarSize {
  label: string;
  honeyOz: number;
}

const DEFAULT_JAR_SIZES: JarSize[] = [
  { label: "Half Pint", honeyOz: 12 },
  { label: "Pint", honeyOz: 22 },
  { label: "Quart", honeyOz: 44 },
  { label: "Half Gallon", honeyOz: 88 },
  { label: "Gallon", honeyOz: 176 },
];

export async function getJarSizes(): Promise<JarSize[]> {
  const users = await db.select().from(userSettings).limit(1);
  const raw = users[0]?.jarSizes;
  if (Array.isArray(raw)) {
    return raw as JarSize[];
  }
  return DEFAULT_JAR_SIZES;
}

export async function updateJarSizes(sizes: JarSize[]) {
  const users = await db.select().from(userSettings).limit(1);
  if (!users[0]) return;

  await db
    .update(userSettings)
    .set({ jarSizes: sizes, updatedAt: new Date() })
    .where(/* eq to users[0].id */);

  revalidatePath("/settings/jar-sizes");
  revalidatePath("/harvest");
}
```

Note: The `where` clause needs the user ID from `users[0].id` — adjust based on the single-user pattern used in this app.

**Step 2: Create the jar size settings page and component**

Create `src/components/settings/jar-size-settings.tsx` — a client component with an editable list of jar sizes (label + oz inputs), add/remove buttons, and a save button that calls `updateJarSizes`.

Create `src/app/(protected)/settings/jar-sizes/page.tsx` — server component that fetches `getJarSizes()` and renders the settings component.

**Step 3: Add link from settings index page**

In `src/app/(protected)/settings/page.tsx`, add a new card linking to `/settings/jar-sizes` with a jar/beaker icon.

**Step 4: Verify build and commit**

```bash
git add src/actions/jar-sizes.ts src/components/settings/jar-size-settings.tsx src/app/(protected)/settings/jar-sizes/ src/app/(protected)/settings/page.tsx
git commit -m "feat: add configurable jar sizes in settings"
```

---

### Task 13: Create Honey Adjustments Actions

**Files:**
- Create: `src/actions/honey-adjustments.ts`

**Step 1: Create the server actions**

Create `src/actions/honey-adjustments.ts`:

```typescript
"use server";

import { db } from "@/db";
import { honeyAdjustments } from "@/db/schema";
import { desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createHoneyAdjustment(
  _prevState: unknown,
  formData: FormData
) {
  const date = formData.get("date") as string;
  const type = formData.get("type") as "jarring_loss" | "other";
  const amountLbs = formData.get("amountLbs") as string;
  const reason = formData.get("reason") as string;

  if (!date) return { error: "Date is required" };
  if (!type) return { error: "Type is required" };
  if (!amountLbs) return { error: "Amount is required" };

  await db.insert(honeyAdjustments).values({
    date: new Date(date),
    type,
    amountLbs: parseFloat(amountLbs),
    reason: reason?.trim() || null,
  });

  revalidatePath("/harvest");
  redirect("/harvest");
}

export async function getHoneyAdjustments() {
  return db
    .select()
    .from(honeyAdjustments)
    .orderBy(desc(honeyAdjustments.date));
}
```

**Step 2: Verify build and commit**

```bash
git add src/actions/honey-adjustments.ts
git commit -m "feat: add honey adjustments server actions"
```

---

### Task 14: Update Honey Dashboard Widget

**Files:**
- Modify: `src/actions/honey.ts` (update `getHoneyDashboard` to include adjustments and jar weights)
- Modify: the honey dashboard widget component

**Step 1: Update getHoneyDashboard**

In `src/actions/honey.ts`, update `getHoneyDashboard` to also fetch:
- Sum of `harvestSessions.totalExtractedWeight` (when sessions exist)
- Sum of `honeyAdjustments.amountLbs`
- Calculate jarred weight from `honeyInventory` using `honeyOz` column

Return: `{ totalHarvested, totalJarredLbs, totalLosses, availableToJar, inventory, totalRevenue }`

**Step 2: Update the dashboard widget to display the new fields**

Show: Extracted, Jarred, Losses, Available to Jar in a 4-column grid.

**Step 3: Verify build and commit**

```bash
git add src/actions/honey.ts src/components/dashboard/
git commit -m "feat: update honey dashboard to show balance (extracted, jarred, losses, available)"
```

---

## Phase 6: Canvas Stands & Grid Layout

### Task 15: Define Canvas Stand Types

**Files:**
- Create: `src/lib/canvas/types.ts`
- Modify: `src/actions/canvas.ts` (update CanvasLayout type)

**Step 1: Create the canvas types file**

Create `src/lib/canvas/types.ts`:

```typescript
export type HivePlacement = "full" | "top" | "bottom" | "left" | "right" | "third-1" | "third-2" | "third-3";

export interface SlotHive {
  hiveId: string;
  facingDegrees: number;
  placement: HivePlacement;
  stackLabel?: string;
}

export interface Slot {
  row: number;
  col: number;
  hives: SlotHive[];
}

export interface Stand {
  id: string;
  label: string;
  x: number;
  y: number;
  rotation: number;
  rows: number;
  cols: number;
  slots: Slot[];
}

export interface CanvasLayout {
  stands: Stand[];
  northArrow: { x: number; y: number; rotation: number };
  zoom: number;
  offsetX: number;
  offsetY: number;
  // Legacy flat hive positions for migration
  hives?: Record<string, { x: number; y: number }>;
}

export function createEmptyStand(label: string, rows: number, cols: number, x: number, y: number): Stand {
  const slots: Slot[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slots.push({ row: r, col: c, hives: [] });
    }
  }
  return {
    id: crypto.randomUUID(),
    label,
    x,
    y,
    rotation: 0,
    rows,
    cols,
    slots,
  };
}

export function getSlotLabel(standLabel: string, row: number, col: number, cols: number): string {
  const slotIndex = row * cols + col + 1;
  return `${standLabel}${slotIndex}`;
}

export function getNextStandLabel(existingStands: Stand[]): string {
  const used = new Set(existingStands.map((s) => s.label));
  for (let i = 0; i < 26; i++) {
    const label = String.fromCharCode(65 + i);
    if (!used.has(label)) return label;
  }
  return `S${existingStands.length + 1}`;
}
```

**Step 2: Update CanvasLayout in actions/canvas.ts**

Update `src/actions/canvas.ts` to import and re-export the new `CanvasLayout` type from `src/lib/canvas/types.ts`. Keep backward compatibility — if `layout.hives` exists (old format) but `layout.stands` doesn't, treat it as legacy.

**Step 3: Verify build and commit**

```bash
git add src/lib/canvas/types.ts src/actions/canvas.ts
git commit -m "feat: define canvas stand types with grid layout and multi-occupant slots"
```

---

### Task 16: Create StandGroup Konva Component

**Files:**
- Create: `src/components/canvas/stand-group.tsx`

**Step 1: Create the StandGroup component**

Create `src/components/canvas/stand-group.tsx` — a react-konva `Group` that renders:
- A background rectangle for the stand (slightly transparent fill)
- A label text above the stand (e.g., "Stand A")
- A grid of slot cells, each rendered as a `Rect`
- For each occupied slot: render hive indicator(s) based on `placement` (full, split top/bottom, split left/right, thirds)
- Direction arrows on each hive indicator
- Slot labels (A1, A2, etc.) inside each cell
- Rotation applied to the whole group
- Drag handles in edit mode
- Resize by changing rows/cols from context menu

The component receives: `stand: Stand`, `editMode: boolean`, `onStandUpdate: (stand: Stand) => void`, `onHiveClick: (hiveId: string) => void`.

Cell size constant: `CELL_SIZE = 60` (one hive footprint).

**Step 2: Verify build and commit**

```bash
git add src/components/canvas/stand-group.tsx
git commit -m "feat: create StandGroup Konva component with grid cells and multi-occupant rendering"
```

---

### Task 17: Add Stand Toolbar, Context Menus, and Canvas Hive Actions

**Files:**
- Create: `src/components/canvas/stand-context-menu.tsx`
- Create: `src/components/canvas/hive-context-menu.tsx`
- Modify: `src/components/canvas/canvas-toolbar.tsx` (add "Add Stand" and "Add Hive" buttons)

**Step 1: Create stand context menu**

Create `src/components/canvas/stand-context-menu.tsx` — an HTML-based context menu (positioned absolutely over the canvas, triggered by right-click on a stand) with options:
- For stands: Rename, Resize (change rows/cols), Rotate (input degrees), Delete
- For empty slots: Add New Hive (creates a hive record and assigns to this slot), Assign Existing Hive
- For occupied slots: Split Hive, Add Nuc, Remove Hive from Slot
- For multi-occupant slots: Move unit to another slot, Promote to full, Recombine

**Step 2: Create hive context menu**

Create `src/components/canvas/hive-context-menu.tsx` — an HTML-based context menu (positioned absolutely, triggered by right-click on a hive within a slot) with quick-action options:
- **New Inspection** → navigates to `/hives/${hiveId}/inspections/new`
- **Quick Inspection** → navigates to `/hives/${hiveId}/inspections/quick`
- **Record Inspection** → navigates to `/hives/${hiveId}/transcribe`
- **Feed** → navigates to `/hives/${hiveId}/feedings/new`
- **Add Equipment** → navigates to `/hives/${hiveId}/equipment/new` (or opens inline form)
- **Take Photo** → navigates to `/hives/${hiveId}/photos/new`
- **View Hive** → navigates to `/hives/${hiveId}`
- Separator
- **Set Facing Direction** → opens angle picker
- **Move to Slot...** → opens slot picker
- **Remove from Stand** → removes hive from slot (doesn't delete hive record)

Props: `{ hiveId, hiveName, position: {x, y}, onClose, onFacingChange, onMove, onRemove }`

Uses `next/navigation` `useRouter` for navigation actions.

**Step 3: Add "Add Stand" and "Add Hive" buttons to toolbar**

In `src/components/canvas/canvas-toolbar.tsx`, add:
- "Add Stand" button (only visible in edit mode) that opens a small popover to pick rows × cols dimensions, then calls a callback to create the stand at center of viewport
- "Add Hive" button (only visible in edit mode) that creates a new hive record and adds it to the first available empty slot (prompts to create a stand first if none exist)

**Step 4: Verify build and commit**

```bash
git add src/components/canvas/stand-context-menu.tsx src/components/canvas/hive-context-menu.tsx src/components/canvas/canvas-toolbar.tsx
git commit -m "feat: add stand/hive context menus with quick actions and canvas toolbar buttons"
```

---

### Task 18: Refactor CanvasInner to Use Stands with Context Menus

**Files:**
- Modify: `src/components/canvas/canvas-inner.tsx`
- Modify: `src/actions/canvas.ts` (add createHiveFromCanvas action)

**Step 1: Add canvas hive creation action**

In `src/actions/canvas.ts`, add a server action that creates a new hive and returns it:

```typescript
export async function createHiveFromCanvas(apiaryId: string, positionLabel: string) {
  const [hive] = await db
    .insert(hives)
    .values({ apiaryId, positionLabel, status: "active" })
    .returning();
  revalidatePath(`/apiaries/${apiaryId}`);
  return hive;
}
```

**Step 2: Refactor CanvasInner**

This is the biggest single change. Replace the flat `hivePositions` state with `stands` state. The component should:

1. On mount, check if `initialLayout` has `stands` (new format) or `hives` (legacy). If legacy, auto-migrate by creating one stand with all hives.
2. Render `<StandGroup>` for each stand instead of individual `<HiveIcon>` components.
3. Handle stand drag, stand rotation, hive drag between slots.
4. On right-click a stand/empty slot: show `<StandContextMenu>` with stand management + "Add New Hive" (calls `createHiveFromCanvas` to create hive record, then assigns to slot).
5. On right-click a hive in a slot: show `<HiveContextMenu>` with quick actions (inspect, feed, photo, view, set facing, move, remove).
6. Save the new `CanvasLayout` format (with `stands` array) when saving.
7. Keep the existing zoom/pan/satellite/north arrow functionality unchanged.

The context menus render as absolutely positioned HTML divs overlaid on the canvas (not Konva shapes) so they can contain links and buttons.

**Step 3: Verify build and test**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/components/canvas/canvas-inner.tsx src/actions/canvas.ts
git commit -m "feat: refactor canvas to use stands with context menus for hive quick actions"
```

---

## Phase 7: Multi-Hive Selector & Bulk Operations

### Task 19: Create HiveMultiSelector Component

**Files:**
- Create: `src/components/bulk/hive-multi-selector.tsx`

**Step 1: Create the component**

Create `src/components/bulk/hive-multi-selector.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface HiveOption {
  id: string;
  positionLabel: string;
  standLabel?: string;
}

interface HiveMultiSelectorProps {
  hives: HiveOption[];
  value: string[];
  onChange: (ids: string[]) => void;
}

export function HiveMultiSelector({ hives, value, onChange }: HiveMultiSelectorProps) {
  const [rangeText, setRangeText] = useState("");

  // Group hives by stand
  const grouped = hives.reduce<Record<string, HiveOption[]>>((acc, h) => {
    const stand = h.standLabel || "Unassigned";
    if (!acc[stand]) acc[stand] = [];
    acc[stand].push(h);
    return acc;
  }, {});

  const toggleHive = (id: string) => {
    onChange(
      value.includes(id) ? value.filter((v) => v !== id) : [...value, id]
    );
  };

  const selectAll = () => onChange(hives.map((h) => h.id));
  const selectNone = () => onChange([]);

  const applyRange = () => {
    // Parse range like "A1-C4" or "A1-A4, B2, C1-C3"
    const parts = rangeText.split(",").map((s) => s.trim());
    const ids = new Set<string>();

    for (const part of parts) {
      const rangeParts = part.split("-");
      if (rangeParts.length === 2) {
        // Range: A1-C4
        const start = rangeParts[0].trim();
        const end = rangeParts[1].trim();
        let inRange = false;
        for (const h of hives) {
          if (h.positionLabel === start) inRange = true;
          if (inRange) ids.add(h.id);
          if (h.positionLabel === end) break;
        }
      } else {
        // Single: B2
        const match = hives.find((h) => h.positionLabel === part);
        if (match) ids.add(match.id);
      }
    }

    onChange(Array.from(ids));
  };

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <Label className="text-sm font-semibold">Select Hives ({value.length} selected)</Label>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={selectAll}>All</Button>
          <Button variant="ghost" size="sm" onClick={selectNone}>None</Button>
        </div>
      </div>
      <Tabs defaultValue="list">
        <TabsList className="mb-2">
          <TabsTrigger value="list">Checkbox List</TabsTrigger>
          <TabsTrigger value="range">Range Picker</TabsTrigger>
        </TabsList>
        <TabsContent value="list">
          <div className="max-h-48 overflow-y-auto space-y-3">
            {Object.entries(grouped).map(([stand, standHives]) => (
              <div key={stand}>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">
                  Stand {stand}
                </p>
                <div className="grid grid-cols-4 gap-1">
                  {standHives.map((h) => (
                    <label key={h.id} className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <Checkbox
                        checked={value.includes(h.id)}
                        onCheckedChange={() => toggleHive(h.id)}
                      />
                      {h.positionLabel}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="range">
          <div className="flex gap-2">
            <Input
              value={rangeText}
              onChange={(e) => setRangeText(e.target.value)}
              placeholder="e.g. A1-C4 or A1, B2, C1-C3"
            />
            <Button onClick={applyRange} size="sm">Apply</Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

**Step 2: Verify build and commit**

```bash
git add src/components/bulk/hive-multi-selector.tsx
git commit -m "feat: create HiveMultiSelector component with checkbox list and range picker modes"
```

---

### Task 20: Add Bulk Equipment Quantity

**Files:**
- Modify: `src/components/equipment/equipment-form.tsx` (add quantity input)
- Modify: `src/actions/equipment.ts` (handle quantity > 1)

**Step 1: Add quantity input to equipment form**

In `src/components/equipment/equipment-form.tsx`, add a quantity `<Input>` field (type number, min 1, default 1) after the existing equipment type select. Add a hidden input `<input type="hidden" name="quantity" value={quantity} />` or just use a regular named input.

**Step 2: Update createEquipment action**

In `src/actions/equipment.ts`, read `quantity` from formData. If > 1, insert N records in a `db.transaction()`:

```typescript
const quantity = parseInt(formData.get("quantity") as string) || 1;

await db.transaction(async (tx) => {
  for (let i = 0; i < quantity; i++) {
    await tx.insert(equipment).values({ /* ... same values */ });
  }
});
```

**Step 3: Verify build and commit**

```bash
git add src/components/equipment/equipment-form.tsx src/actions/equipment.ts
git commit -m "feat: add quantity field to equipment form for bulk creation"
```

---

### Task 21: Create Bulk Action Forms on Apiary Page

**Files:**
- Create: `src/components/bulk/bulk-feeding-form.tsx`
- Create: `src/components/bulk/bulk-inspection-form.tsx`
- Create: `src/components/bulk/bulk-equipment-form.tsx`
- Create: `src/actions/bulk.ts`
- Modify: `src/app/(protected)/apiaries/[id]/page.tsx` (add Bulk Actions tab)

**Step 1: Create bulk server actions**

Create `src/actions/bulk.ts`:

```typescript
"use server";

import { db } from "@/db";
import { inspections, feedings, equipment } from "@/db/schema";
import { revalidatePath } from "next/cache";

export async function bulkCreateInspections(
  _prevState: unknown,
  formData: FormData
) {
  const hiveIdsJson = formData.get("hiveIds") as string;
  const date = formData.get("date") as string;
  const notes = formData.get("notes") as string;

  if (!hiveIdsJson || !date) return { error: "Hives and date are required" };

  const hiveIds: string[] = JSON.parse(hiveIdsJson);
  if (hiveIds.length === 0) return { error: "Select at least one hive" };

  await db.transaction(async (tx) => {
    for (const hiveId of hiveIds) {
      await tx.insert(inspections).values({
        hiveId,
        date: new Date(date),
        notes: notes?.trim() || null,
      });
    }
  });

  revalidatePath("/dashboard");
  return { success: true, count: hiveIds.length };
}

export async function bulkCreateFeedings(
  _prevState: unknown,
  formData: FormData
) {
  const hiveIdsJson = formData.get("hiveIds") as string;
  const dateFed = formData.get("dateFed") as string;
  const type = formData.get("type") as string;
  const quantity = formData.get("quantity") as string;
  const quantityUnit = formData.get("quantityUnit") as string;
  const feederType = formData.get("feederType") as string;
  const notes = formData.get("notes") as string;

  if (!hiveIdsJson || !dateFed || !type || !quantity || !quantityUnit) {
    return { error: "Required fields missing" };
  }

  const hiveIds: string[] = JSON.parse(hiveIdsJson);
  if (hiveIds.length === 0) return { error: "Select at least one hive" };

  await db.transaction(async (tx) => {
    for (const hiveId of hiveIds) {
      await tx.insert(feedings).values({
        hiveId,
        dateFed: new Date(dateFed),
        type: type as "sugar_syrup_1to1" | "sugar_syrup_2to1" | "dry_sugar" | "pollen_patty" | "fondant" | "other",
        quantity: parseFloat(quantity),
        quantityUnit: quantityUnit as "lbs" | "oz" | "quarts" | "gallons",
        feederType: feederType && feederType !== "__none__" ? feederType as "entrance" | "top" | "frame" | "baggie" | "bucket" | "open" | "other" : null,
        notes: notes?.trim() || null,
      });
    }
  });

  revalidatePath("/dashboard");
  return { success: true, count: hiveIds.length };
}
```

**Step 2: Create bulk form components**

Create `src/components/bulk/bulk-feeding-form.tsx` — embeds `<HiveMultiSelector>` at top + feeding form fields (same as existing feeding-form.tsx but with multi-hive selection instead of single hiveId). Uses `bulkCreateFeedings` action. Passes selected hive IDs as JSON hidden input.

Create `src/components/bulk/bulk-inspection-form.tsx` — same pattern with inspection fields.

Create `src/components/bulk/bulk-equipment-form.tsx` — same pattern with equipment fields + quantity.

**Step 3: Add Bulk Actions tab to apiary page**

In `src/app/(protected)/apiaries/[id]/page.tsx`, add a new `TabsTrigger value="bulk"` and `TabsContent value="bulk"` section with the three bulk forms.

**Step 4: Verify build and commit**

```bash
git add src/actions/bulk.ts src/components/bulk/ src/app/(protected)/apiaries/[id]/page.tsx
git commit -m "feat: add bulk action forms (inspection, feeding, equipment) to apiary page"
```

---

### Task 22: Bulk Hive Entry

**Files:**
- Create: `src/components/bulk/bulk-hive-form.tsx`
- Modify: `src/actions/hives.ts` (add bulkCreateHives)

**Step 1: Add bulkCreateHives action**

In `src/actions/hives.ts`, add:

```typescript
export async function bulkCreateHives(
  _prevState: unknown,
  formData: FormData
) {
  const apiaryId = formData.get("apiaryId") as string;
  const quantity = parseInt(formData.get("quantity") as string);
  const startLabel = formData.get("startLabel") as string;

  if (!apiaryId || !quantity || quantity < 1) {
    return { error: "Apiary and valid quantity required" };
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < quantity; i++) {
      const label = startLabel
        ? `${startLabel}${i + 1}`
        : `Hive ${i + 1}`;
      await tx.insert(hives).values({
        apiaryId,
        positionLabel: label,
        status: "active",
      });
    }
  });

  revalidatePath(`/apiaries/${apiaryId}`);
  return { success: true, count: quantity };
}
```

**Step 2: Create bulk hive form component**

Create `src/components/bulk/bulk-hive-form.tsx` with: quantity input, optional start label prefix (e.g., "A" → creates A1, A2, A3...), submit.

**Step 3: Add to apiary hives tab**

In the Hives tab of the apiary page, add a "Bulk Add Hives" button/section alongside the existing "Add Hive" button.

**Step 4: Verify build and commit**

```bash
git add src/actions/hives.ts src/components/bulk/bulk-hive-form.tsx src/app/(protected)/apiaries/[id]/page.tsx
git commit -m "feat: add bulk hive entry form to apiary page"
```

---

## Phase 8: Apiary-Level Recordings

### Task 23: Add Recording Button to Apiary Page

**Files:**
- Modify: `src/app/(protected)/apiaries/[id]/page.tsx`
- Create: `src/components/recording/apiary-recording-handler.tsx`

**Step 1: Create the apiary recording handler**

Create `src/components/recording/apiary-recording-handler.tsx` — a client component that:
1. Renders a `<RecordingButton>` with `mode="batch"`
2. On recording complete, uploads the audio blob to the server
3. Creates a media file record with `ownerType="apiary"`, `ownerId={apiaryId}`
4. Triggers transcription job via existing BullMQ queue
5. Shows status/progress

**Step 2: Add to apiary page header**

In `src/app/(protected)/apiaries/[id]/page.tsx`, add the `<ApiaryRecordingHandler>` in the header area next to the Edit button.

**Step 3: Verify build and commit**

```bash
git add src/components/recording/apiary-recording-handler.tsx src/app/(protected)/apiaries/[id]/page.tsx
git commit -m "feat: add recording button to apiary page for batch recordings"
```

---

### Task 24: Update Transcription Parser for Apiary-Level

**Files:**
- Modify: `src/lib/ai/transcription-parser.ts`

**Step 1: Add apiary-level mode to parser**

In `src/lib/ai/transcription-parser.ts`, the batch mode prompt already handles multiple hives. When processing an apiary-level recording:
- Use `batch` mode with the existing `BATCH_MODE_PROMPT`
- After parsing, the `hiveReference` field on each `ParsedInspection` should match against hive position labels (A1, B2, etc.)
- Add a helper function `matchHiveReferences` that takes the parsed results and an array of hive position labels, and maps `hiveReference` strings to actual hive IDs

```typescript
export function matchHiveReferences(
  inspections: ParsedInspection[],
  hives: Array<{ id: string; positionLabel: string }>
): Array<ParsedInspection & { matchedHiveId?: string }> {
  return inspections.map((insp) => {
    if (!insp.hiveReference) return insp;

    const ref = insp.hiveReference.toLowerCase().trim();
    const match = hives.find((h) => {
      const label = h.positionLabel.toLowerCase();
      return ref === label || ref.includes(label) || label.includes(ref);
    });

    return { ...insp, matchedHiveId: match?.id };
  });
}
```

**Step 2: Verify build and commit**

```bash
git add src/lib/ai/transcription-parser.ts
git commit -m "feat: add hive reference matching to transcription parser for apiary recordings"
```

---

## Phase 9: Ollama AI Enhancements

### Task 25: Add Model Discovery to Ollama Provider

**Files:**
- Modify: `src/lib/ai/ollama.ts`
- Modify: `src/actions/ai-settings.ts`

**Step 1: Add model listing to OllamaProvider**

In `src/lib/ai/ollama.ts`, add a static method:

```typescript
static async listModels(baseUrl: string = "http://localhost:11434"): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json() as { models?: Array<{ name: string }> };
    return (data.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}
```

**Step 2: Update AI settings to expose model list**

In `src/actions/ai-settings.ts`, add:

```typescript
export async function getOllamaModels(baseUrl?: string) {
  const { OllamaProvider } = await import("@/lib/ai/ollama");
  return OllamaProvider.listModels(baseUrl || "http://localhost:11434");
}
```

**Step 3: Verify build and commit**

```bash
git add src/lib/ai/ollama.ts src/actions/ai-settings.ts
git commit -m "feat: add Ollama model discovery via /api/tags endpoint"
```

---

### Task 26: Update AI Settings UI for Ollama Model Picker

**Files:**
- Modify: `src/components/settings/ai-provider-config.tsx` (or wherever the AI settings form is)

**Step 1: Update the AI settings form**

When "Ollama" is selected as a provider for any task, show:
- URL input (default `http://localhost:11434`)
- "Discover Models" button that calls `getOllamaModels(url)` and populates a dropdown
- Model dropdown (populated from discovery)

This uses a client-side fetch to a server action or API route.

**Step 2: Verify build and commit**

```bash
git add src/components/settings/ai-provider-config.tsx
git commit -m "feat: add Ollama model picker with auto-discovery to AI settings"
```

---

## Phase 10: Flowering Species Tracker

### Task 27: Create Bloom Observation Server Actions

**Files:**
- Create: `src/actions/bloom-observations.ts`

**Step 1: Create the server actions**

Create `src/actions/bloom-observations.ts`:

```typescript
"use server";

import { db } from "@/db";
import { bloomObservations, apiaries } from "@/db/schema";
import { eq, desc, and, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function createBloomObservation(
  _prevState: unknown,
  formData: FormData
) {
  const apiaryId = formData.get("apiaryId") as string;
  const species = formData.get("species") as string;
  const dateFirstSeen = formData.get("dateFirstSeen") as string;
  const abundance = formData.get("abundance") as string;
  const notes = formData.get("notes") as string;

  if (!apiaryId || !species || !dateFirstSeen) {
    return { error: "Apiary, species, and date are required" };
  }

  const year = new Date(dateFirstSeen).getFullYear();

  await db.insert(bloomObservations).values({
    apiaryId,
    species: species.trim(),
    dateFirstSeen,
    year,
    abundance: abundance ? parseInt(abundance) : null,
    notes: notes?.trim() || null,
  });

  revalidatePath(`/apiaries/${apiaryId}`);
  return { success: true };
}

export async function endBloom(id: string, apiaryId: string) {
  const today = new Date().toISOString().split("T")[0];
  await db
    .update(bloomObservations)
    .set({ dateLastSeen: today })
    .where(eq(bloomObservations.id, id));

  revalidatePath(`/apiaries/${apiaryId}`);
}

export async function updateBloomLastSeen(id: string, apiaryId: string) {
  const today = new Date().toISOString().split("T")[0];
  await db
    .update(bloomObservations)
    .set({ dateLastSeen: today })
    .where(eq(bloomObservations.id, id));

  revalidatePath(`/apiaries/${apiaryId}`);
}

export async function getActiveBloomsForApiary(apiaryId: string) {
  return db
    .select()
    .from(bloomObservations)
    .where(
      and(
        eq(bloomObservations.apiaryId, apiaryId),
        isNull(bloomObservations.dateLastSeen)
      )
    )
    .orderBy(desc(bloomObservations.dateFirstSeen));
}

export async function getBloomHistoryForApiary(apiaryId: string) {
  return db
    .select()
    .from(bloomObservations)
    .where(eq(bloomObservations.apiaryId, apiaryId))
    .orderBy(desc(bloomObservations.year), desc(bloomObservations.dateFirstSeen));
}

export async function getBloomSpeciesAutocomplete(apiaryId: string) {
  const result = await db
    .select({ species: bloomObservations.species })
    .from(bloomObservations)
    .where(eq(bloomObservations.apiaryId, apiaryId))
    .groupBy(bloomObservations.species)
    .orderBy(desc(sql`max(${bloomObservations.dateFirstSeen})`));

  return result.map((r) => r.species);
}
```

**Step 2: Verify build and commit**

```bash
git add src/actions/bloom-observations.ts
git commit -m "feat: add bloom observation server actions (create, end, history, autocomplete)"
```

---

### Task 28: Create Flora Tab Components

**Files:**
- Create: `src/components/flora/active-blooms.tsx`
- Create: `src/components/flora/bloom-form.tsx`
- Create: `src/components/flora/bloom-history.tsx`

**Step 1: Create active blooms component**

Create `src/components/flora/active-blooms.tsx` — displays currently blooming species in a card list with "End Bloom" and "Still Blooming" action buttons on each. Includes a "+" FAB to add new bloom.

**Step 2: Create bloom form**

Create `src/components/flora/bloom-form.tsx` — compact form with:
- Species text input with autocomplete (from previous entries)
- Date first seen (defaults today)
- Abundance 1-5 select
- Notes textarea
- Submit button

**Step 3: Create bloom history**

Create `src/components/flora/bloom-history.tsx` — table of all observations, filterable by year dropdown. Shows species, first seen, last seen, abundance, notes.

**Step 4: Verify build and commit**

```bash
git add src/components/flora/
git commit -m "feat: create flora tab components (active blooms, form, history)"
```

---

### Task 29: Add Flora Tab to Apiary Page

**Files:**
- Modify: `src/app/(protected)/apiaries/[id]/page.tsx`

**Step 1: Add Flora tab**

In the apiary page, add a new `TabsTrigger value="flora"` and `TabsContent value="flora"` section. Fetch bloom data in the page's server component:

```tsx
const [apiary, hives, photos, activeBlooms, bloomHistory, speciesList] = await Promise.all([
  getApiary(id),
  getHivesForApiary(id),
  getPhotosForOwner("apiary", id),
  getActiveBloomsForApiary(id),
  getBloomHistoryForApiary(id),
  getBloomSpeciesAutocomplete(id),
]);
```

Render the flora components inside the tab.

**Step 2: Verify build and commit**

```bash
git add src/app/(protected)/apiaries/[id]/page.tsx
git commit -m "feat: add Flora tab to apiary page with bloom tracking"
```

---

## Final Verification

After all phases are complete:

1. Run: `npx tsc --noEmit` — expect 0 errors
2. Run: `npx drizzle-kit push` — ensure all migrations applied
3. Run: `npm run dev` — verify app loads
4. Test: Dark mode toggle works
5. Test: Create a stand on the canvas, add hives, drag between slots
6. Test: Bulk feeding from apiary page
7. Test: Create harvest session, add entries, true-up
8. Test: Add bloom observation from Flora tab
9. Test: Quick inspection from hive page
