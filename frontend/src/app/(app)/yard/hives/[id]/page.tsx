import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { HiveDetailPage } from "@/features/hives/detail-page";

export const metadata: Metadata = { title: "Hive" };

export default async function HivePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  if (
    query.tab === "equipment" ||
    query.tab === "queen" ||
    query.tab === "photos"
  ) {
    redirect(`/yard/hives/${id}/${query.tab}`);
  }
  // The detail page keeps its tab and timeline filter in search params.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <HiveDetailPage hiveId={id} />
    </Suspense>
  );
}
