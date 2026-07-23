"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import type { ConfirmInspection, ParsedInspection } from "./api";

/** Editable, string-friendly form state for one inspection card. */
export interface EditableInspection {
  hiveReference: string | null;
  queenSeen: boolean;
  queenHealth: string;
  broodPattern: string;
  storesHoney: string;
  storesPollen: string;
  temperament: string;
  pests: { type: string; count: string }[];
  treatments: { product: string; method: string }[];
  notes: string;
}

const BROOD_PATTERNS = [
  "excellent",
  "good",
  "fair",
  "poor",
  "spotty",
  "none",
] as const;

/** Radix Select forbids empty item values; sentinel for "not recorded". */
const UNSET = "not-recorded";

export function toEditable(p?: ParsedInspection | null): EditableInspection {
  return {
    hiveReference: p?.hiveReference ?? null,
    queenSeen: p?.queenSeen ?? false,
    queenHealth: p?.queenHealth ?? "",
    broodPattern:
      p?.broodPattern &&
      (BROOD_PATTERNS as readonly string[]).includes(p.broodPattern)
        ? p.broodPattern
        : "",
    storesHoney: p?.storesHoney ? String(p.storesHoney) : "",
    storesPollen: p?.storesPollen ? String(p.storesPollen) : "",
    temperament: p?.temperament ? String(p.temperament) : "",
    pests: (p?.pests ?? []).map((pest) => ({
      type: pest.type ?? "",
      count: pest.count ?? "",
    })),
    treatments: (p?.treatments ?? []).map((t) => ({
      product: t.product ?? "",
      method: t.method ?? "",
    })),
    notes: p?.notes ?? "",
  };
}

/** Maps the editable card back to the confirm payload shape. */
export function toConfirmPayload(
  e: EditableInspection,
  hiveId?: string | null,
): ConfirmInspection {
  const pests = e.pests
    .map((p) => ({ type: p.type.trim(), count: p.count.trim() || null }))
    .filter((p) => p.type !== "");
  const treatments = e.treatments
    .map((t) => ({ product: t.product.trim(), method: t.method.trim() || null }))
    .filter((t) => t.product !== "");
  return {
    hiveId: hiveId ?? null,
    hiveReference: e.hiveReference,
    queenSeen: e.queenSeen,
    queenHealth: e.queenHealth.trim() || null,
    broodPattern: e.broodPattern || null,
    storesHoney: e.storesHoney ? Number(e.storesHoney) : null,
    storesPollen: e.storesPollen ? Number(e.storesPollen) : null,
    temperament: e.temperament ? Number(e.temperament) : null,
    pests: pests.length > 0 ? pests : null,
    treatments: treatments.length > 0 ? treatments : null,
    notes: e.notes.trim() || null,
  };
}

interface RatingSelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  labels?: Record<string, string>;
  dense?: boolean;
}

function RatingSelect({ id, value, onChange, labels, dense }: RatingSelectProps) {
  return (
    <Select
      value={value || UNSET}
      onValueChange={(v) => onChange(v === UNSET ? "" : v)}
    >
      <SelectTrigger id={id} className={cn(dense && "h-8 text-xs")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET}>Not recorded</SelectItem>
        {["1", "2", "3", "4", "5"].map((n) => (
          <SelectItem key={n} value={n}>
            {labels?.[n] ? `${n} — ${labels[n]}` : n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface InspectionFieldsProps {
  value: EditableInspection;
  onChange: (value: EditableInspection) => void;
  /** Compact spacing for batch review cards. */
  dense?: boolean;
  /** Unique prefix so labels/inputs stay linked across multiple cards. */
  idPrefix: string;
  disabled?: boolean;
}

/**
 * Editable inspection card fields, shared by single and batch review: queen
 * seen/health, brood pattern, stores + temperament selects, dynamic pest and
 * treatment lists, and notes.
 */
export function InspectionFields({
  value,
  onChange,
  dense,
  idPrefix,
  disabled,
}: InspectionFieldsProps) {
  const set = <K extends keyof EditableInspection>(
    key: K,
    v: EditableInspection[K],
  ) => onChange({ ...value, [key]: v });

  const labelClass = cn(dense && "text-xs");
  const inputClass = cn(dense && "h-8 text-xs");

  return (
    <fieldset disabled={disabled} className={cn("grid", dense ? "gap-3" : "gap-4")}>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${idPrefix}-queen-seen`}
          checked={value.queenSeen}
          onCheckedChange={(checked) => set("queenSeen", checked === true)}
        />
        <Label htmlFor={`${idPrefix}-queen-seen`} className={labelClass}>
          Queen seen
        </Label>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-queen-health`} className={labelClass}>
          Queen health
        </Label>
        <Input
          id={`${idPrefix}-queen-health`}
          className={inputClass}
          value={value.queenHealth}
          onChange={(e) => set("queenHealth", e.target.value)}
          placeholder="e.g. laying well, marked, replaced"
        />
      </div>

      <div className={cn("grid gap-3", dense ? "grid-cols-2" : "sm:grid-cols-2")}>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-brood`} className={labelClass}>
            Brood pattern
          </Label>
          <Select
            value={value.broodPattern || UNSET}
            onValueChange={(v) => set("broodPattern", v === UNSET ? "" : v)}
          >
            <SelectTrigger id={`${idPrefix}-brood`} className={inputClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>Not recorded</SelectItem>
              {BROOD_PATTERNS.map((p) => (
                <SelectItem key={p} value={p} className="capitalize">
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-temperament`} className={labelClass}>
            Temperament
          </Label>
          <RatingSelect
            id={`${idPrefix}-temperament`}
            value={value.temperament}
            onChange={(v) => set("temperament", v)}
            labels={{ "1": "Calm", "3": "Moderate", "5": "Aggressive" }}
            dense={dense}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-honey`} className={labelClass}>
            Honey stores
          </Label>
          <RatingSelect
            id={`${idPrefix}-honey`}
            value={value.storesHoney}
            onChange={(v) => set("storesHoney", v)}
            labels={{ "1": "Low", "3": "Moderate", "5": "Full" }}
            dense={dense}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-pollen`} className={labelClass}>
            Pollen stores
          </Label>
          <RatingSelect
            id={`${idPrefix}-pollen`}
            value={value.storesPollen}
            onChange={(v) => set("storesPollen", v)}
            labels={{ "1": "Low", "3": "Moderate", "5": "Full" }}
            dense={dense}
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label className={labelClass}>Pests</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              set("pests", [...value.pests, { type: "", count: "" }])
            }
          >
            <Plus />
            Add pest
          </Button>
        </div>
        {value.pests.length === 0 && (
          <p className="text-xs text-muted-foreground">No pests recorded.</p>
        )}
        {value.pests.map((pest, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              className={inputClass}
              value={pest.type}
              onChange={(e) =>
                set(
                  "pests",
                  value.pests.map((p, j) =>
                    j === i ? { ...p, type: e.target.value } : p,
                  ),
                )
              }
              placeholder="Pest (e.g. varroa)"
              aria-label={`Pest ${i + 1} type`}
            />
            <Input
              className={cn("max-w-28", inputClass)}
              value={pest.count}
              onChange={(e) =>
                set(
                  "pests",
                  value.pests.map((p, j) =>
                    j === i ? { ...p, count: e.target.value } : p,
                  ),
                )
              }
              placeholder="Count"
              aria-label={`Pest ${i + 1} count`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove pest ${i + 1}`}
              onClick={() =>
                set(
                  "pests",
                  value.pests.filter((_, j) => j !== i),
                )
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label className={labelClass}>Treatments</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              set("treatments", [
                ...value.treatments,
                { product: "", method: "" },
              ])
            }
          >
            <Plus />
            Add treatment
          </Button>
        </div>
        {value.treatments.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No treatments recorded.
          </p>
        )}
        {value.treatments.map((treatment, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              className={inputClass}
              value={treatment.product}
              onChange={(e) =>
                set(
                  "treatments",
                  value.treatments.map((t, j) =>
                    j === i ? { ...t, product: e.target.value } : t,
                  ),
                )
              }
              placeholder="Product (e.g. Apivar)"
              aria-label={`Treatment ${i + 1} product`}
            />
            <Input
              className={inputClass}
              value={treatment.method}
              onChange={(e) =>
                set(
                  "treatments",
                  value.treatments.map((t, j) =>
                    j === i ? { ...t, method: e.target.value } : t,
                  ),
                )
              }
              placeholder="Method"
              aria-label={`Treatment ${i + 1} method`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove treatment ${i + 1}`}
              onClick={() =>
                set(
                  "treatments",
                  value.treatments.filter((_, j) => j !== i),
                )
              }
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-notes`} className={labelClass}>
          Notes
        </Label>
        <Textarea
          id={`${idPrefix}-notes`}
          className={cn(dense && "text-xs")}
          rows={dense ? 2 : 4}
          value={value.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Anything else worth remembering"
        />
      </div>
    </fieldset>
  );
}
