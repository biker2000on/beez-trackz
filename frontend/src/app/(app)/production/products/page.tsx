import type { Metadata } from "next";

import { HiveProductsPage } from "@/features/honey/products-page";

export const metadata: Metadata = { title: "Hive products" };

export default function ProductsRoute() {
  return (
    <div className="mx-auto grid w-full max-w-none gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Hive products</h1>
        <p className="text-sm text-muted-foreground">
          Creamed honey, hot honey, mead, propolis, and tincture on the same
          sale spine as jars.
        </p>
      </div>
      <HiveProductsPage />
    </div>
  );
}
