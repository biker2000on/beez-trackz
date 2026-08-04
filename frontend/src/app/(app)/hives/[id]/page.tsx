import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { HiveDetailPage } from "@/features/hives/detail-page";

export const metadata: Metadata = { title: "Hive" };

export default async function HivePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The detail page keeps its tab and timeline filter in search params.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <HiveDetailPage hiveId={id} />
    </Suspense>
  );
}
