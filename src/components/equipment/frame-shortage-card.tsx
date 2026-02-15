import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const BOX_TYPE_LABELS: Record<string, string> = {
  deep: "Deeps",
  medium: "Mediums",
  shallow: "Shallows",
};

const FRAME_TYPE_LABELS: Record<string, string> = {
  wax_foundation: "wax",
  plastic: "plastic",
  foundationless: "foundationless",
  drawn_comb: "drawn comb",
};

interface BreakdownItem {
  boxType: string;
  frameType: string | null;
  capacity: number;
  installed: number;
  shortage: number;
}

interface FrameShortageData {
  totalCapacity: number;
  totalInstalled: number;
  shortage: number;
  breakdown: BreakdownItem[];
}

interface FrameShortageCardProps {
  data: FrameShortageData;
}

export function FrameShortageCard({ data }: FrameShortageCardProps) {
  const { totalCapacity, totalInstalled, shortage, breakdown } = data;

  if (totalCapacity === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Frame Status</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No frame-bearing equipment tracked yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  const shortageItems = breakdown.filter((b) => b.shortage > 0);

  // Group shortages by box type for compact display
  const grouped = new Map<string, { total: number; details: string[] }>();
  for (const item of shortageItems) {
    const key = item.boxType;
    if (!grouped.has(key)) {
      grouped.set(key, { total: 0, details: [] });
    }
    const group = grouped.get(key)!;
    group.total += item.shortage;
    if (item.frameType) {
      group.details.push(
        `${item.shortage} ${FRAME_TYPE_LABELS[item.frameType] || item.frameType}`
      );
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Frame Status</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {/* Summary line */}
          <p className="text-sm">
            <span className="font-semibold">{totalInstalled}</span>
            <span className="text-muted-foreground"> / {totalCapacity}</span>
            {shortage > 0 ? (
              <span className="text-destructive font-medium">
                {" "}&mdash; {shortage} frame{shortage !== 1 ? "s" : ""} short
              </span>
            ) : (
              <span className="text-green-600 dark:text-green-400 font-medium">
                {" "}&mdash; fully stocked
              </span>
            )}
          </p>

          {/* Per-box-type breakdown (only shortages) */}
          {shortageItems.length > 0 && (
            <ul className="text-xs text-muted-foreground space-y-0.5 pl-2 border-l-2 border-muted">
              {Array.from(grouped.entries()).map(([boxType, group]) => (
                <li key={boxType}>
                  <span className="font-medium text-foreground">
                    {BOX_TYPE_LABELS[boxType] || boxType}:
                  </span>{" "}
                  {group.total} short
                  {group.details.length > 0 && (
                    <span> ({group.details.join(", ")})</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
