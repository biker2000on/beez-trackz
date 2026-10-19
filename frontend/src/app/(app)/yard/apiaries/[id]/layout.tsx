import { Suspense } from "react";

import { RecordHeaderSkeleton } from "@/components/record/record-header";
import { ApiaryRecordLayout } from "@/features/apiaries/record-layout";
import { pageMetadata } from "@/lib/page-title";

// First paint carries the list's title; the record layout replaces it with
// "Name · Apiary list · Brand" once the apiary has loaded.
export const metadata = pageMetadata("/yard/apiaries");

/**
 * RecordPage for an apiary (ui-coherence brief §5): the header, action bar
 * and tab strip are rendered here, once, so every page under
 * `/yard/apiaries/[id]` renders only its body.
 */
export default async function ApiaryLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<RecordHeaderSkeleton tabs={6} />}>
      <ApiaryRecordLayout apiaryId={id}>{children}</ApiaryRecordLayout>
    </Suspense>
  );
}
