
import { GenealogyView } from "@/features/queens/genealogy-view";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/yard/queens");

export default function GenealogyPage() {
  return <GenealogyView />;
}
