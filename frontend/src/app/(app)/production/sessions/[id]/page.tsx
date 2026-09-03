import type { Metadata } from "next";

import { SessionDetail } from "@/features/honey/session-detail";

export const metadata: Metadata = { title: "Harvest session" };

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SessionDetail id={id} />;
}
