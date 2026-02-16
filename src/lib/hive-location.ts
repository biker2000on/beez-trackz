/**
 * Generate a display label from structured location fields.
 * Format: "{StandLabel}{Row}{Col}" e.g. "A1", "B3"
 * Non-full placement appends suffix: "A1 (top)"
 */
export function generatePositionLabel(
  standLabel: string | null | undefined,
  slotRow: number | null | undefined,
  slotCol: number | null | undefined,
  placement: string | null | undefined
): string {
  if (!standLabel && slotRow == null && slotCol == null) {
    return "Unassigned";
  }

  const stand = standLabel || "?";
  const row = slotRow != null ? String(slotRow) : "";
  const col = slotCol != null ? String(slotCol) : "";

  let label = `${stand}${row}${col ? "-" + col : ""}`;

  if (placement && placement !== "full") {
    label += ` (${placement})`;
  }

  return label;
}
