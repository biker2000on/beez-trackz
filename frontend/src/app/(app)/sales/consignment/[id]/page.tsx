import { pageMetadata } from "@/lib/page-title";
import { ConsignmentLocationPage } from "@/features/commerce/consignment-location-page";

// First paint carries the list title; the record header sets "Name · List · Brand".
export const metadata = pageMetadata("/sales/consignment");

export default async function ConsignmentLocationRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ConsignmentLocationPage locationId={id} />;
}
