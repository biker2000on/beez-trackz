import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ApiaryDetailPage } from "@/features/apiaries/detail-page";

const LEGACY_TABS = new Set(["overview", "layout", "flora", "photos"]);

export default async function ApiaryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  // The tabs used to live in `?tab=`; every one is a route now.
  if (typeof query.tab === "string" && LEGACY_TABS.has(query.tab)) {
    redirect(`/yard/apiaries/${id}/${query.tab}`);
  }
  // The bare record URL opens the map.
  return (
    <Suspense fallback={<Skeleton className="h-[430px] rounded-xl" />}>
      <ApiaryDetailPage apiaryId={id} />
    </Suspense>
  );
}
