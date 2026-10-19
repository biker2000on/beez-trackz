import { VarietalsView } from "@/features/honey/varietals-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/production/varietals");

export default function VarietalsPage() {
  return (
    <div className="mx-auto grid w-full max-w-none gap-4">
      <VarietalsView />
    </div>
  );
}
