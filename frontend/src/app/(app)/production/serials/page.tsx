import { PageHeader } from "@/components/shell/page-header";
import { SerialLookup } from "@/features/commerce/serial-lookup";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/production/serials");

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
      <PageHeader subtitle="Trace one jar back to its bottling run, harvest lot and the order it left on." />
      <SerialLookup initialSerial={serial ?? ""} />
    </div>
  );
}
