import { ApiarySubpage } from "@/features/apiaries/subpage";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApiarySubpage apiaryId={id} section="photos" />;
}
