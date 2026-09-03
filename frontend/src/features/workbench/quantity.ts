/**
 * Workbench quantity display.
 *
 * The ledger's decimals arrive as strings (`"42.250"`) so their scale
 * survives JSON. They are formatted with the honey feature's own formatter —
 * imported, not reimplemented, so a pound reads the same on the workbench as
 * it does on the lots tab — and the verbatim server string is kept alongside
 * on a data attribute, because a rounded display must never become the number
 * an operator copies into a count.
 */

import { formatLbs } from "@/features/honey/format";

import type { Quantity } from "./types";

/** The server's value, verbatim, for `data-*` attributes and tests. */
export function exact(value: Quantity | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Human-facing pounds; falls back to the verbatim value if unparsable. */
export function lbs(value: Quantity | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  return formatLbs(parsed);
}

/** A signed difference, so a true-up residual reads as a direction. */
export function signedLbs(value: Quantity | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  return `${parsed > 0 ? "+" : ""}${formatLbs(parsed)}`;
}
