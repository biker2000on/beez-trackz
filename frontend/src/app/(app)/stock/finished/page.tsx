import { Suspense } from "react";
import { StockWorkspace } from "@/features/equipment/stock-workspace";
export default function Page() {
  return (
    <Suspense>
      <StockWorkspace category="finished" />
    </Suspense>
  );
}
