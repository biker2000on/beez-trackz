import type { Metadata } from "next";

import { SerialLookup } from "@/features/commerce/serial-lookup";

export const metadata: Metadata = { title: "Serial lookup" };

/**
 * `?serial=` makes a lookup shareable and lets other surfaces (a sale's linked
 * jar list, for one) deep-link straight to a jar's chain.
 */
export default async function SerialLookupPage({
  searchParams,
}: {
  searchParams: Promise<{ serial?: string }>;
}) {
  const { serial } = await searchParams;
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Serial lookup</h1>
        <p className="text-sm text-muted-foreground">
          Trace one jar back to its bottling run, harvest lot, and the order it
          left on.
        </p>
      </div>
      <SerialLookup initialSerial={serial ?? ""} />
    </div>
  );
}
