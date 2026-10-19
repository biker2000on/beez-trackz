import { redirect } from "next/navigation";

import { preserveQuery } from "@/lib/redirect-query";

/**
 * Production › Activity moved to Stock › Movements, the one canonical
 * movement ledger. Old links and bookmarks keep their sort and filters.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(preserveQuery("/stock/movements", await searchParams));
}
