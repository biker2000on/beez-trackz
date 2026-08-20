import type { Metadata } from "next";

import { ConsignmentLocationPage } from "@/features/commerce/consignment-location-page";

export const metadata: Metadata = { title: "Consignment location" };

export default async function ConsignmentLocationRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ConsignmentLocationPage locationId={id} />;
}
