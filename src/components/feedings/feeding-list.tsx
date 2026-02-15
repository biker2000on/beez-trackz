"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { markFeedingEmpty } from "@/actions/feedings";
import { useTransition } from "react";

interface FeedingEntry {
  id: string;
  hiveId: string;
  dateFed: Date;
  type: string;
  quantity: number;
  quantityUnit: string;
  feederType: string | null;
  dateEmpty: Date | null;
  notes: string | null;
}

interface FeedingListProps {
  feedings: FeedingEntry[];
  hiveId: string;
}

const FEED_TYPE_LABELS: Record<string, string> = {
  sugar_syrup_1to1: "Sugar Syrup 1:1",
  sugar_syrup_2to1: "Sugar Syrup 2:1",
  dry_sugar: "Dry Sugar",
  pollen_patty: "Pollen Patty",
  fondant: "Fondant",
  other: "Other",
};

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function FeedingItem({ feeding }: { feeding: FeedingEntry }) {
  const [isPending, startTransition] = useTransition();
  const isActive = !feeding.dateEmpty;

  function handleMarkEmpty() {
    startTransition(async () => {
      await markFeedingEmpty(feeding.id);
    });
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0 space-y-2">
            {/* Date & type */}
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">
                {formatDate(feeding.dateFed)}
              </span>
              <Badge variant="outline">
                {FEED_TYPE_LABELS[feeding.type] || feeding.type}
              </Badge>
            </div>

            {/* Quantity & feeder details */}
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">
                {feeding.quantity} {feeding.quantityUnit}
              </Badge>
              {feeding.feederType && (
                <Badge variant="outline" className="capitalize">
                  {feeding.feederType} feeder
                </Badge>
              )}
              {isActive ? (
                <Badge
                  variant="outline"
                  className="bg-blue-500/10 text-blue-700 border-blue-200"
                >
                  Active
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="bg-gray-500/10 text-gray-600 border-gray-200"
                >
                  Emptied {formatDate(feeding.dateEmpty!)}
                </Badge>
              )}
            </div>

            {/* Notes */}
            {feeding.notes && (
              <p className="text-xs text-muted-foreground">{feeding.notes}</p>
            )}
          </div>

          {/* Mark empty action */}
          {isActive && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleMarkEmpty}
              disabled={isPending}
              className="flex-shrink-0"
            >
              {isPending ? "..." : "Mark Empty"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function FeedingList({ feedings, hiveId }: FeedingListProps) {
  if (feedings.length === 0) {
    return (
      <p className="text-muted-foreground text-sm text-center py-4">
        No feedings recorded yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {feedings.map((feeding) => (
        <FeedingItem key={feeding.id} feeding={feeding} />
      ))}
    </div>
  );
}
