import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { ApiaryDetailPage } from "@/features/apiaries/detail-page";

export const metadata: Metadata = { title: "Apiary" };

export default async function ApiaryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  if (query.tab === "flora" || query.tab === "photos") {
    redirect(`/apiaries/${id}/${query.tab}`);
  }
  // The detail page keeps its active tab in a search param.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ApiaryDetailPage apiaryId={id} />
    </Suspense>
  );
}
