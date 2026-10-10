import { Suspense } from "react";
import { ApiaryDetailPage } from "@/features/apiaries/detail-page";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense>
      <ApiaryDetailPage apiaryId={id} section="layout" />
    </Suspense>
  );
}
