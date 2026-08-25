import type { Metadata } from "next";

import { JarsTab } from "@/features/honey/jars-tab";

export const metadata: Metadata = { title: "Jars" };

export default function JarsPage() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Jars</h1>
        <p className="text-sm text-muted-foreground">
          Packaged stock on hand, derived from the honey ledger.
        </p>
      </div>
      <JarsTab />
    </div>
  );
}
