import { redirect } from "next/navigation";

/**
 * Production › Activity moved to Stock › Movements, the one canonical
 * movement ledger. Old links and bookmarks keep their sort and filters.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : value == null ? [] : [value]) {
      params.append(key, item);
    }
  }
  const search = params.toString();
  redirect(search ? `/stock/movements?${search}` : "/stock/movements");
}
