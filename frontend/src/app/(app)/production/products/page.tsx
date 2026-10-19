import { PageHeader } from "@/components/shell/page-header";
import { HiveProductsPage } from "@/features/honey/products-page";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/production/products");

export default function ProductsRoute() {
  return (
    <div className="mx-auto grid w-full max-w-none gap-4">
      <PageHeader subtitle="Make and sell creamed honey, hot honey, mead, propolis and tinctures alongside jars." />
      <HiveProductsPage />
    </div>
  );
}
