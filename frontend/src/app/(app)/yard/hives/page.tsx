
import { HivesListPage } from "@/features/hives/list-page";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/yard/hives");

export default function HivesPage() {
  return <HivesListPage />;
}
