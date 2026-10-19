import { PageHeader } from "@/components/shell/page-header";
import { HarvestsTab } from "@/features/honey/harvests-tab";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/production/harvests");

export default function HarvestsPage() {
  return (
    <div className="mx-auto grid w-full max-w-none gap-4">
      <PageHeader subtitle="Record extraction sessions and what each hive gave." />
      <HarvestsTab />
    </div>
  );
}
