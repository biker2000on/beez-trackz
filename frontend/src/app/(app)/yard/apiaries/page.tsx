import type { Metadata } from "next";

import { ApiariesListPage } from "@/features/apiaries/list-page";

export const metadata: Metadata = { title: "Apiaries" };

export default function ApiariesPage() {
  return <ApiariesListPage />;
}
