import { redirect } from "next/navigation";

export default async function QuickInspectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/hives/${id}`);
}
