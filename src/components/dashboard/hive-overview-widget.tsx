import Link from "next/link";
import { getHives } from "@/actions/hives";
import { getApiaries } from "@/actions/apiaries";

const statusColors: Record<string, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  dead: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
  sold: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  combined: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
};

export async function HiveOverviewWidget() {
  const [allHives, allApiaries] = await Promise.all([
    getHives(),
    getApiaries(),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const hive of allHives) {
    statusCounts[hive.status] = (statusCounts[hive.status] || 0) + 1;
  }

  const totalHives = allHives.length;
  const totalApiaries = allApiaries.length;

  if (totalHives === 0 && totalApiaries === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        <p>No hives or apiaries yet.</p>
        <Link href="/apiaries" className="text-primary hover:underline text-xs mt-1 inline-block">
          Create your first apiary
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-bold">{totalHives}</span>
        <span className="text-sm text-muted-foreground">
          {totalHives === 1 ? "hive" : "hives"} across{" "}
          <Link href="/apiaries" className="text-primary hover:underline">
            {totalApiaries} {totalApiaries === 1 ? "apiary" : "apiaries"}
          </Link>
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {Object.entries(statusCounts).map(([status, count]) => (
          <span
            key={status}
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[status] || "bg-gray-100 text-gray-800"}`}
          >
            {count} {status}
          </span>
        ))}
      </div>

      <div className="pt-1">
        <Link href="/hives" className="text-xs text-primary hover:underline">
          View all hives
        </Link>
      </div>
    </div>
  );
}
