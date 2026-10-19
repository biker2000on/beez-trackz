import { redirect } from "next/navigation";

import { preserveQuery } from "@/lib/redirect-query";

/** Retired: bulk stock is a tab of Stock › On hand. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(preserveQuery("/stock", await searchParams, { tab: "bulk" }));
}
