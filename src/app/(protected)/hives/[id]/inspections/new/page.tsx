import { redirect } from "next/navigation";

export default async function NewInspectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/hives/${id}`);
}
