import { ApiaryObservations } from "@/features/apiaries/observations-page";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApiaryObservations apiaryId={id} />;
}
