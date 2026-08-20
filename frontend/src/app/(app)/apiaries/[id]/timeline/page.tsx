import type { Metadata } from "next";

import { ApiaryTimelinePage } from "@/features/photos/apiary-timeline-page";

export const metadata: Metadata = { title: "Yard timeline" };

export default async function TimelinePage({ params }: PageProps<"/apiaries/[id]/timeline">) {
  const { id } = await params;
  return <ApiaryTimelinePage apiaryId={id} />;
}
