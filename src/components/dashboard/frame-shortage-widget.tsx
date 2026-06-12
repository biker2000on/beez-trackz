import Link from "next/link";
import { getFrameSummary } from "@/actions/equipment-v2";

export async function FrameShortageWidget() {
  const summary = await getFrameSummary();

  if (summary.grandTotal === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        <p>No equipment tracked</p>
        <Link
          href="/inventory"
          className="text-primary hover:underline text-xs mt-1 inline-block"
        >
          Add equipment
        </Link>
      </div>
    );
  }

  const spareFrames = summary.standalone.total;
  const lowOnFrames = spareFrames < 10;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            lowOnFrames
              ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
              : "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
          }`}
        >
          {spareFrames} spare frames
        </span>
        <span className="text-xs text-muted-foreground">
          {summary.boxFrameCapacity} frame slots in field
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Drawn</p>
          <p className="font-semibold">{summary.standalone.drawn}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Fresh</p>
          <p className="font-semibold">{summary.standalone.fresh}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Other</p>
          <p className="font-semibold">{summary.standalone.unspecified}</p>
        </div>
      </div>

      <div className="pt-1">
        <Link href="/inventory" className="text-xs text-primary hover:underline">
          Manage inventory
        </Link>
      </div>
    </div>
  );
}
