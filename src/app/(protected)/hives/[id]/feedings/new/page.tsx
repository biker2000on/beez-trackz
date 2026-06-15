import { redirect } from "next/navigation";

export default async function NewFeedingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/hives/${id}`);
}
