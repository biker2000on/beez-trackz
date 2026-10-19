import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ApiaryDetailPage } from "@/features/apiaries/detail-page";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<Skeleton className="h-[430px] rounded-xl" />}>
      <ApiaryDetailPage apiaryId={id} section="layout" />
    </Suspense>
  );
}
