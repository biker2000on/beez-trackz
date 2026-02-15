const QUEEN_COLORS = ["blue", "white", "yellow", "red", "green"] as const;

export type QueenColor = (typeof QUEEN_COLORS)[number];

export function getQueenColor(year: number): QueenColor {
  return QUEEN_COLORS[year % 5];
}

export function getQueenColorForDate(date: Date | null): QueenColor | null {
  if (!date) return null;
  return getQueenColor(date.getFullYear());
}

export const QUEEN_COLOR_HEX: Record<QueenColor, string> = {
  blue: "#3B82F6",
  white: "#F8FAFC",
  yellow: "#EAB308",
  red: "#EF4444",
  green: "#22C55E",
};
