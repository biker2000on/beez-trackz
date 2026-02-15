import Link from "next/link";
import { getHoneyDashboard } from "@/actions/honey";

export async function HoneyInventoryWidget() {
  const dashboard = await getHoneyDashboard();

  const hasData =
    dashboard.totalHarvested > 0 ||
    dashboard.totalJarredLbs > 0 ||
    dashboard.totalLosses > 0 ||
    dashboard.inventory.length > 0 ||
    dashboard.totalRevenue > 0;

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

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Extracted</p>
          <p className="text-lg font-bold">
            {dashboard.totalHarvested.toFixed(1)}{" "}
            <span className="text-xs font-normal text-muted-foreground">lbs</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Jarred</p>
          <p className="text-lg font-bold">
            {dashboard.totalJarredLbs.toFixed(1)}{" "}
            <span className="text-xs font-normal text-muted-foreground">lbs</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Losses</p>
          <p className="text-lg font-bold">
            {dashboard.totalLosses.toFixed(1)}{" "}
            <span className="text-xs font-normal text-muted-foreground">lbs</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Available</p>
          <p className="text-lg font-bold">
            {dashboard.availableToJar.toFixed(1)}{" "}
            <span className="text-xs font-normal text-muted-foreground">lbs</span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 pt-2 border-t">
        <div>
          <p className="text-xs text-muted-foreground">Revenue</p>
          <p className="text-lg font-bold">
            ${dashboard.totalRevenue.toFixed(2)}
          </p>
        </div>
      </div>

      {dashboard.inventory.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">
            Jar Inventory
          </p>
          <div className="flex flex-wrap gap-2">
            {dashboard.inventory.map((item) => (
              <span
                key={item.jarSize}
                className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs dark:bg-amber-950 dark:border-amber-800"
              >
                {item.jarSize}: {item.totalQuantity}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="pt-1">
        <Link href="/harvest" className="text-xs text-primary hover:underline">
          View harvest details
        </Link>
      </div>
    </div>
  );
}
