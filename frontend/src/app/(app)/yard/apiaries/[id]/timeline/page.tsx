import { ApiaryTimelinePage } from "@/features/photos/apiary-timeline-page";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApiaryTimelinePage apiaryId={id} />;
}
