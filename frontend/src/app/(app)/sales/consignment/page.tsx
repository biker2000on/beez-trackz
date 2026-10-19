
import { ConsignmentPage } from "@/features/commerce/consignment-page";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/sales/consignment");

export default function ConsignmentRoute() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <ConsignmentPage />
    </div>
  );
}
