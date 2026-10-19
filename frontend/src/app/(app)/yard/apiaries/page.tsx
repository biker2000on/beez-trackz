
import { ApiariesListPage } from "@/features/apiaries/list-page";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/yard/apiaries");

export default function ApiariesPage() {
  return <ApiariesListPage />;
}
