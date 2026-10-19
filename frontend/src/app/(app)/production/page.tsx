import { ProductionWorkbench } from "@/features/workbench/production-workbench";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/production");

export default function Page() { return <ProductionWorkbench />; }
