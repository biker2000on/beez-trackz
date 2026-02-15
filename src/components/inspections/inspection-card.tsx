import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Pencil } from "lucide-react";

interface PestRow {
  type: string;
  count: number;
}

interface InspectionCardProps {
  inspection: {
    id: string;
    hiveId: string;
    date: Date;
    inspectorName?: string | null;
    queenSeen?: boolean | null;
    storesHoney?: number | null;
    storesPollen?: number | null;
    temperament?: number | null;
    pests?: PestRow[] | unknown;
    notes?: string | null;
  };
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getPestCount(pests: unknown): number {
  if (!Array.isArray(pests)) return 0;
  return (pests as PestRow[]).reduce(
    (sum, p) => sum + (p.count || 0),
    0
  );
}

export function InspectionCard({ inspection }: InspectionCardProps) {
  const pestCount = getPestCount(inspection.pests);
  const truncatedNotes =
    inspection.notes && inspection.notes.length > 120
      ? inspection.notes.slice(0, 120) + "..."
      : inspection.notes;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0 space-y-2">
            {/* Date & inspector */}
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">
                {formatDate(inspection.date)}
              </span>
              {inspection.inspectorName && (
                <span className="text-xs text-muted-foreground">
                  by {inspection.inspectorName}
                </span>
              )}
            </div>

            {/* Key findings badges */}
            <div className="flex flex-wrap gap-1.5">
              <Badge
                variant="outline"
                className={
                  inspection.queenSeen
                    ? "bg-green-500/10 text-green-700 border-green-200"
                    : "bg-gray-500/10 text-gray-600 border-gray-200"
                }
              >
                Queen {inspection.queenSeen ? "seen" : "not seen"}
              </Badge>

              {inspection.storesHoney != null && (
                <Badge variant="outline">
                  Honey: {inspection.storesHoney}/5
                </Badge>
              )}

              {inspection.storesPollen != null && (
                <Badge variant="outline">
                  Pollen: {inspection.storesPollen}/5
                </Badge>
              )}

              {inspection.temperament != null && (
                <Badge variant="outline">
                  Temper: {inspection.temperament}/5
                </Badge>
              )}

              {pestCount > 0 && (
                <Badge
                  variant="outline"
                  className="bg-red-500/10 text-red-700 border-red-200"
                >
                  {pestCount} pest{pestCount !== 1 ? "s" : ""}
                </Badge>
              )}
            </div>

            {/* Truncated notes */}
            {truncatedNotes && (
              <p className="text-xs text-muted-foreground">{truncatedNotes}</p>
            )}
          </div>

          {/* Edit link */}
          <Link
            href={`/hives/${inspection.hiveId}/inspections/${inspection.id}/edit`}
            className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          >
            <Pencil className="h-4 w-4" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
