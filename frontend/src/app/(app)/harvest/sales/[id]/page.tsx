import { redirect } from "next/navigation";

export default async function HarvestReceiptRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/honey/sales/${id}`);
}
