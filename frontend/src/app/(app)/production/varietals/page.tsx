import type { Metadata } from "next";

import { VarietalsView } from "@/features/honey/varietals-view";

export const metadata: Metadata = { title: "Varietals & lot balances" };

export default function VarietalsPage() {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4">
      <VarietalsView />
    </div>
  );
}
