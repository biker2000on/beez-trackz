import Link from "next/link";
import { getActiveFeedings } from "@/actions/feedings";

export async function FeedingStatusWidget() {
  const activeFeedings = await getActiveFeedings();

  if (activeFeedings.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No active feeders</p>
    );
  }

  const now = new Date();
  const needsAttention = activeFeedings.filter((f) => {
    const daysSinceFed = Math.floor(
      (now.getTime() - new Date(f.dateFed).getTime()) / (1000 * 60 * 60 * 24)
    );
    return daysSinceFed > 7;
  });

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-bold">{activeFeedings.length}</span>
        <span className="text-sm text-muted-foreground">
          active {activeFeedings.length === 1 ? "feeder" : "feeders"}
        </span>
      </div>

      {needsAttention.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
            Needs attention ({">"}7 days):
          </p>
          <ul className="space-y-1">
            {needsAttention.slice(0, 4).map((f) => {
              const daysSinceFed = Math.floor(
                (now.getTime() - new Date(f.dateFed).getTime()) /
                  (1000 * 60 * 60 * 24)
              );
              return (
                <li key={f.id}>
                  <Link
                    href={`/hives/${f.hiveId}`}
                    className="flex items-center justify-between text-sm hover:text-primary transition-colors"
                  >
                    <span className="truncate">{f.hiveName}</span>
                    <span className="text-xs text-muted-foreground shrink-0 ml-2">
                      {daysSinceFed}d ago
                    </span>
                  </Link>
                </li>
              );
            })}
            {needsAttention.length > 4 && (
              <li className="text-xs text-muted-foreground">
                +{needsAttention.length - 4} more
              </li>
            )}
          </ul>
        </div>
      )}

      {needsAttention.length === 0 && (
        <p className="text-xs text-green-600 dark:text-green-400">
          All feeders recently filled
        </p>
      )}
    </div>
  );
}
