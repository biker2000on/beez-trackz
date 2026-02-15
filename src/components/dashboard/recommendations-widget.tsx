import Link from "next/link";
import { getActiveRecommendations, getRecommendationCount } from "@/actions/recommendations";

const priorityColors: Record<string, string> = {
  urgent: "border-l-red-500 bg-red-50 dark:bg-red-950",
  high: "border-l-orange-500 bg-orange-50 dark:bg-orange-950",
  normal: "border-l-blue-500 bg-blue-50 dark:bg-blue-950",
  low: "border-l-gray-400 bg-gray-50 dark:bg-gray-900",
};

const priorityBadgeColors: Record<string, string> = {
  urgent: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  normal: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  low: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};

export async function RecommendationsWidget() {
  const [recommendations, totalCount] = await Promise.all([
    getActiveRecommendations(),
    getRecommendationCount(),
  ]);

  if (recommendations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No recommendations</p>
    );
  }

  const top3 = recommendations.slice(0, 3);
  const remaining = totalCount - top3.length;

  return (
    <div className="space-y-2">
      {top3.map((rec) => (
        <div
          key={rec.id}
          className={`border-l-4 rounded-r-md p-2 ${priorityColors[rec.priority] || priorityColors.normal}`}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm leading-tight">{rec.message}</p>
            <span
              className={`shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${priorityBadgeColors[rec.priority] || priorityBadgeColors.normal}`}
            >
              {rec.priority}
            </span>
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between pt-1">
        <Link href="/recommendations" className="text-xs text-primary hover:underline">
          View all
        </Link>
        {remaining > 0 && (
          <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            +{remaining} more
          </span>
        )}
      </div>
    </div>
  );
}
