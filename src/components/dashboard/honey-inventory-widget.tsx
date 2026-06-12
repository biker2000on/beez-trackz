import Link from "next/link";
import { getHoneyOverview } from "@/actions/honey";

export async function HoneyInventoryWidget() {
  const overview = await getHoneyOverview();

  const hasData =
    overview.totalHarvestedLbs > 0 ||
    overview.jarredLbs > 0 ||
    overview.totalRevenue > 0 ||
    overview.inventory.some((i) => i.onHand > 0);

  if (!hasData) {
    return (
      <div className="text-sm text-muted-foreground">
        <p>No honey data yet</p>
        <Link
          href="/harvest"
          className="text-primary hover:underline text-xs mt-1 inline-block"
        >
          Record a harvest
        </Link>
      </div>
    );
  }

  const jarsOnHand = overview.inventory.reduce((s, i) => s + i.onHand, 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Harvested</p>
          <p className="text-lg font-bold tabular-nums">
            {overview.totalHarvestedLbs.toFixed(1)}{" "}
            <span className="text-xs font-normal text-muted-foreground">lbs</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Bulk on hand</p>
          <p className="text-lg font-bold tabular-nums">
            {overview.bulkOnHandLbs.toFixed(1)}{" "}
            <span className="text-xs font-normal text-muted-foreground">lbs</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Jars on hand</p>
          <p className="text-lg font-bold tabular-nums">{jarsOnHand}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Revenue</p>
          <p className="text-lg font-bold tabular-nums">
            ${overview.totalRevenue.toFixed(2)}
          </p>
        </div>
      </div>

      {jarsOnHand > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {overview.inventory
            .filter((i) => i.onHand > 0)
            .map((i) => (
              <span
                key={i.jarSizeId}
                className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs"
              >
                {i.onHand} × {i.label}
              </span>
            ))}
        </div>
      )}

      <div className="pt-1">
        <Link href="/harvest" className="text-xs text-primary hover:underline">
          Manage honey
        </Link>
      </div>
    </div>
  );
}
