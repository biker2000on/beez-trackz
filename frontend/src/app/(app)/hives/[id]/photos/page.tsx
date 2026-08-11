import type { Metadata } from "next";

import { HiveSubpage } from "@/features/hives/subpage";

export const metadata: Metadata = { title: "Hive photos" };

export default async function HivePhotosPage({ params }: PageProps<"/hives/[id]/photos">) {
  const { id } = await params;
  return <HiveSubpage hiveId={id} section="photos" />;
}
