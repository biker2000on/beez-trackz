import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ApiaryDetailPage } from "@/features/apiaries/detail-page";

export const metadata: Metadata = { title: "Apiary" };

export default async function ApiaryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The detail page keeps its active tab in a search param.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ApiaryDetailPage apiaryId={id} />
    </Suspense>
  );
}
