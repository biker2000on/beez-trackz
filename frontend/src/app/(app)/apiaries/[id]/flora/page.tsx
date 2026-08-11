import type { Metadata } from "next";

import { ApiarySubpage } from "@/features/apiaries/subpage";

export const metadata: Metadata = { title: "Apiary flora" };

export default async function ApiaryFloraPage({ params }: PageProps<"/apiaries/[id]/flora">) {
  const { id } = await params;
  return <ApiarySubpage apiaryId={id} section="flora" />;
}
