import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { HiveDetailPage } from "@/features/hives/detail-page";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <HiveDetailPage hiveId={id} section="health" />
    </Suspense>
  );
}
