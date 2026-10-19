import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { HiveDetailPage } from "@/features/hives/detail-page";

const LEGACY_TABS = new Set([
  "timeline",
  "health",
  "equipment",
  "queen",
  "photos",
]);

export default async function HivePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  // The tabs used to live in `?tab=`; every one is a route now. The rest of
  // the query (a timeline filter, say) travels with the redirect.
  const { tab, ...rest } = query;
  if (typeof tab === "string" && LEGACY_TABS.has(tab)) {
    const carried = new URLSearchParams();
    for (const [key, value] of Object.entries(rest)) {
      if (typeof value === "string") carried.set(key, value);
    }
    const suffix = carried.size > 0 ? `?${carried}` : "";
    redirect(`/yard/hives/${id}/${tab}${suffix}`);
  }
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <HiveDetailPage hiveId={id} />
    </Suspense>
  );
}
