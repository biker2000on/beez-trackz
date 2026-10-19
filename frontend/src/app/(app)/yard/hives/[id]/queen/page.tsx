import { HiveSubpage } from "@/features/hives/subpage";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <HiveSubpage hiveId={id} section="queen" />;
}
