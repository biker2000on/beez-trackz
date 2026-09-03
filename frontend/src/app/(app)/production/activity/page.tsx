import type { Metadata } from "next";

import { ActivityTab } from "@/features/honey/activity-tab";

export const metadata: Metadata = { title: "Honey activity" };

export default function ActivityPage() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground">
          The honey ledger: jarring, sales, give-aways, use, loss and
          adjustments.
        </p>
      </div>
      <ActivityTab />
    </div>
  );
}
