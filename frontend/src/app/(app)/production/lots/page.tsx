import { PageHeader } from "@/components/shell/page-header";
import { LotsTab } from "@/features/commerce/lots-tab";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/production/lots");

export default function LotsPage() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <PageHeader subtitle="Give each harvest a traceable lot, then print its labels and QR codes." />
      <LotsTab />
    </div>
  );
}
