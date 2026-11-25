/**
 * Converts between what the voice parser heard (`ParsedInspection`), the
 * shared inspection fields' form state, and the confirm payload. Also writes
 * the one-line summary the visit ledger shows for each hive.
 */

import {
  emptyInspectionValues,
  emptyMiteRow,
  feedingTypeShort,
  isBlankMiteRow,
  isBoardMiteMethod,
  miteMethodLabel,
  normalizeInspectionValues,
  BROOD_PATTERNS,
  QUEEN_EVENT_LABELS,
  temperamentText,
  type InspectionFieldValues,
} from "@/features/inspections/inspection-fields";

import type { ConfirmInspection, ParsedInspection } from "./api";
import type { ReviewDraft } from "./capture-store";

const numberText = (value: number | null | undefined) =>
  value != null && value !== 0 ? String(value) : "";

export function fromParsed(p?: ParsedInspection | null): InspectionFieldValues {
  const base = emptyInspectionValues();
  if (!p) return base;
  return {
    ...base,
    hiveReference: p.hiveReference ?? null,
    queenSeen: p.queenSeen ?? null,
    queenHealth: p.queenHealth ?? "",
    broodPattern:
      p.broodPattern && (BROOD_PATTERNS as readonly string[]).includes(p.broodPattern)
        ? p.broodPattern
        : (p.broodPattern ?? ""),
    storesHoney: numberText(p.storesHoney),
    storesPollen: numberText(p.storesPollen),
    temperament: numberText(p.temperament),
    framesOfBees: p.framesOfBees != null ? String(p.framesOfBees) : "",
    framesOfBrood: p.framesOfBrood != null ? String(p.framesOfBrood) : "",
    framesOfStores: p.framesOfStores != null ? String(p.framesOfStores) : "",
    pests: (p.pests ?? []).map((pest) => ({
      type: pest.type ?? "",
      count: pest.count ?? "",
    })),
    treatments: (p.treatments ?? []).map((t) => ({
      product: t.product ?? "",
      method: t.method ?? "",
    })),
    feedings: (p.feedings ?? []).map((feeding) => ({
      type: feeding.type,
      quantity: String(feeding.quantity),
      quantityUnit: feeding.quantityUnit,
      feederType: feeding.feederType ?? "other",
      notes: feeding.notes ?? "",
    })),
    queenEvents: (p.queenEvents ?? []).map((event) => ({
      eventType: event.eventType,
      notes: event.notes ?? "",
    })),
    miteCounts: (p.miteCounts ?? []).map((count) => ({
      ...emptyMiteRow(count.method),
      mitesCount: String(count.mitesCount),
      sampleSize: count.sampleSize == null ? "" : String(count.sampleSize),
      notes: count.notes ?? "",
    })),
    notes: p.notes ?? "",
  };
}

/** The editable values for a draft, including drafts saved by older builds. */
export function draftValues(draft: ReviewDraft): InspectionFieldValues {
  return draft.editable
    ? normalizeInspectionValues(draft.editable)
    : fromParsed(draft.fields);
}

const optionalNumber = (value: string) => (value.trim() ? Number(value) : null);

/** Maps the edited fields back to the confirm payload shape. */
export function toConfirmPayload(
  e: InspectionFieldValues,
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
    storesHoney: optionalNumber(e.storesHoney),
    storesPollen: optionalNumber(e.storesPollen),
    temperament: optionalNumber(e.temperament),
    framesOfBees: optionalNumber(e.framesOfBees),
    framesOfBrood: optionalNumber(e.framesOfBrood),
    framesOfStores: optionalNumber(e.framesOfStores),
    pests: pests.length > 0 ? pests : null,
    treatments: treatments.length > 0 ? treatments : null,
    feedings: e.feedings
      .map((feeding) => ({
        type: feeding.type,
        quantity: Number(feeding.quantity),
        quantityUnit: feeding.quantityUnit,
        feederType: feeding.feederType,
        notes: feeding.notes.trim() || null,
      }))
      .filter((feeding) => feeding.quantity > 0),
    queenEvents: e.queenEvents.map((event) => ({
      eventType: event.eventType,
      notes: event.notes.trim() || null,
    })),
    miteCounts: e.miteCounts
      .filter((count) => !isBlankMiteRow(count))
      .map((count) => ({
        method: count.method,
        mitesCount: Number(count.mitesCount),
        sampleSize:
          isBoardMiteMethod(count.method) || !count.sampleSize.trim()
            ? null
            : Number(count.sampleSize),
        notes: count.notes.trim() || null,
      }))
      .filter((count) => Number.isInteger(count.mitesCount) && count.mitesCount >= 0),
    notes: e.notes.trim() || null,
  };
}

/** "Lid popped, strong · Queen seen · Calm · 3 mites / 300 · Fed 2 gallons 1:1 syrup" */
export function summarizeFields(fields: ConfirmInspection): string {
  const parts: string[] = [];
  const note = fields.notes?.trim().split("\n")[0];
  if (note) parts.push(note);
  if (fields.queenSeen === true) parts.push("Queen seen");
  if (fields.queenSeen === false) parts.push("Queen not seen");
  const temper = temperamentText(fields.temperament);
  if (temper) parts.push(temper);
  for (const count of fields.miteCounts ?? []) {
    parts.push(
      count.sampleSize
        ? `${count.mitesCount} mites / ${count.sampleSize}`
        : `${count.mitesCount} mites (${miteMethodLabel(count.method).toLowerCase()})`,
    );
  }
  for (const feeding of fields.feedings ?? []) {
    parts.push(
      `Fed ${feeding.quantity} ${feeding.quantityUnit} ${feedingTypeShort(feeding.type)}`,
    );
  }
  for (const treatment of fields.treatments ?? []) parts.push(treatment.product);
  for (const pest of fields.pests ?? []) parts.push(pest.type);
  for (const event of fields.queenEvents ?? [])
    parts.push(QUEEN_EVENT_LABELS[event.eventType] ?? event.eventType);
  return parts.join(" · ");
}

/** The visit's calendar day where it was recorded, for the timeline link. */
export function visitDay(
  observedAt: string,
  timeZone: string,
): { iso: string; label: string } {
  const date = new Date(observedAt);
  const format = (zone: string | undefined) => ({
    iso: new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date),
    label: new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      month: "short",
      day: "numeric",
    }).format(date),
  });
  try {
    return format(timeZone);
  } catch {
    // An unknown zone name from an old capture: fall back to this device.
    return format(undefined);
  }
}
