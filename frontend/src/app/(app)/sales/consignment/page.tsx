import type { Metadata } from "next";

import { ConsignmentPage } from "@/features/commerce/consignment-page";

export const metadata: Metadata = { title: "Consignment" };

export default function ConsignmentRoute() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <ConsignmentPage />
    </div>
  );
}
