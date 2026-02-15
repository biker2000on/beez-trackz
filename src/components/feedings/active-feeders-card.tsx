import Link from "next/link";
import { Badge } from "@/components/ui/badge";

interface ActiveFeeding {
  id: string;
  hiveId: string;
  dateFed: Date;
  type: string;
  quantity: number;
  quantityUnit: string;
  feederType: string | null;
  hiveName: string;
  apiaryName: string;
}

interface ActiveFeedersCardProps {
  feedings: ActiveFeeding[];
}

const FEED_TYPE_LABELS: Record<string, string> = {
  sugar_syrup_1to1: "Syrup 1:1",
  sugar_syrup_2to1: "Syrup 2:1",
  dry_sugar: "Dry Sugar",
  pollen_patty: "Pollen Patty",
  fondant: "Fondant",
  other: "Other",
};

function daysSince(date: Date): number {
  const now = new Date();
  const fed = new Date(date);
  const diff = now.getTime() - fed.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export function ActiveFeedersCard({ feedings }: ActiveFeedersCardProps) {
  if (feedings.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No active feeders</p>
    );
  }

  return (
    <div className="space-y-3">
      {feedings.map((feeding) => {
        const days = daysSince(feeding.dateFed);
        return (
          <Link
            key={feeding.id}
            href={`/hives/${feeding.hiveId}`}
            className="block"
          >
            <div className="flex items-start justify-between gap-2 text-sm hover:bg-muted/50 rounded-md p-1.5 -mx-1.5 transition-colors">
              <div className="min-w-0">
                <span className="font-medium">{feeding.hiveName}</span>
                <span className="text-muted-foreground">
                  {" "}
                  &middot; {feeding.apiaryName}
                </span>
                <div className="flex flex-wrap gap-1 mt-1">
                  <Badge variant="outline" className="text-xs">
                    {FEED_TYPE_LABELS[feeding.type] || feeding.type}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    {feeding.quantity} {feeding.quantityUnit}
                  </Badge>
                </div>
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">
                {days === 0
                  ? "Today"
                  : days === 1
                    ? "1 day ago"
                    : `${days} days ago`}
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
