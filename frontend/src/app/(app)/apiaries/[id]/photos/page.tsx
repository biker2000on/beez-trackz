import type { Metadata } from "next";

import { ApiarySubpage } from "@/features/apiaries/subpage";

export const metadata: Metadata = { title: "Apiary photos" };

export default async function ApiaryPhotosPage({ params }: PageProps<"/apiaries/[id]/photos">) {
  const { id } = await params;
  return <ApiarySubpage apiaryId={id} section="photos" />;
}
