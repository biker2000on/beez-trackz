/**
 * Build a redirect target that keeps the caller's search params (a lot
 * scope, a sort) and adds the ones the new page needs.
 */
export function preserveQuery(
  pathname: string,
  query: Record<string, string | string[] | undefined>,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : value == null ? [] : [value]) {
      params.append(key, item);
    }
  }
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}
