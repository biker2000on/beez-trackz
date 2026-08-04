import type { Metadata } from "next";

import { CustomersView } from "@/features/operations/report-views";

export const metadata: Metadata = { title: "Customers & wholesale" };

export default function CustomersPage() {
  return <CustomersView />;
}
