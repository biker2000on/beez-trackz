import { Suspense } from "react";
import { VisitWorkspace } from "@/features/transcription/visit-workspace";

export const metadata = { title: "Inspection visit" };
export default async function VisitPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<p>Loading visit…</p>}>
      <VisitWorkspace apiaryId={id} />
    </Suspense>
  );
}
