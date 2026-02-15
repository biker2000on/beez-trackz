import Link from "next/link";
import { getRecentInspections } from "@/actions/inspections";

export async function RecentInspectionsWidget() {
  const inspections = await getRecentInspections(5);

  if (inspections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No recent inspections</p>
    );
  }

  return (
    <div className="space-y-1">
      <ul className="divide-y">
        {inspections.map((insp) => (
          <li key={insp.id} className="py-2 first:pt-0 last:pb-0">
            <Link
              href={`/hives/${insp.hiveId}`}
              className="group flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                  {insp.hiveName}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {insp.apiaryName}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {insp.queenSeen && (
                  <span
                    className="inline-flex items-center rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900 dark:text-green-200"
                    title="Queen seen"
                  >
                    Q
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {new Date(insp.date).toLocaleDateString()}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <div className="pt-2">
        <Link href="/hives" className="text-xs text-primary hover:underline">
          View all hives
        </Link>
      </div>
    </div>
  );
}
