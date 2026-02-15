import Link from "next/link";
import { getFrameShortage } from "@/actions/equipment";

export async function FrameShortageWidget() {
  const shortage = await getFrameShortage();

  if (shortage.breakdown.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        <p>No equipment tracked</p>
        <Link
          href="/settings/equipment"
          className="text-primary hover:underline text-xs mt-1 inline-block"
        >
          Add equipment
        </Link>
      </div>
    );
  }

  const hasShortage = shortage.shortage > 0;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          {hasShortage ? (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">
              {shortage.shortage} frames needed
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-200">
              Fully stocked
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {shortage.totalInstalled}/{shortage.totalCapacity} filled
        </span>
      </div>

      {hasShortage && (
        <ul className="space-y-1">
          {shortage.breakdown
            .filter((b) => b.shortage > 0)
            .map((b, i) => (
              <li
                key={i}
                className="flex items-center justify-between text-sm"
              >
                <span className="capitalize">
                  {b.boxType}
                  {b.frameType ? ` (${b.frameType})` : ""}
                </span>
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  need {b.shortage} more
                </span>
              </li>
            ))}
        </ul>
      )}

      <div className="pt-1">
        <Link
          href="/settings/equipment"
          className="text-xs text-primary hover:underline"
        >
          Manage equipment
        </Link>
      </div>
    </div>
  );
}
