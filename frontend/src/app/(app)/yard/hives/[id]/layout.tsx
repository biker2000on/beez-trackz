import { Suspense } from "react";

import { RecordHeaderSkeleton } from "@/components/record/record-header";
import { HiveRecordLayout } from "@/features/hives/record-layout";
import { pageMetadata } from "@/lib/page-title";

// First paint carries the list's title; the record layout replaces it with
// "Name · Hives · Brand" once the hive has loaded.
export const metadata = pageMetadata("/yard/hives");

/**
 * RecordPage for a hive (ui-coherence brief §5): the header, action bar and
 * tab strip are rendered here, once, so every page under `/yard/hives/[id]`
 * renders only its body.
 */
export default async function HiveLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<RecordHeaderSkeleton tabs={6} />}>
      <HiveRecordLayout hiveId={id}>{children}</HiveRecordLayout>
    </Suspense>
  );
}
