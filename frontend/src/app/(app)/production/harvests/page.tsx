import type { Metadata } from "next";

import { HarvestsTab } from "@/features/honey/harvests-tab";

export const metadata: Metadata = { title: "Harvests" };

export default function HarvestsPage() {
  return (
    <div className="mx-auto grid w-full max-w-none gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Harvests</h1>
      <HarvestsTab />
    </div>
  );
}
