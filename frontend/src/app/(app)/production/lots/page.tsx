import type { Metadata } from "next";

import { LotsTab } from "@/features/commerce/lots-tab";

export const metadata: Metadata = { title: "Lots & QR" };

export default function LotsPage() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Lots &amp; QR</h1>
      <LotsTab />
    </div>
  );
}
