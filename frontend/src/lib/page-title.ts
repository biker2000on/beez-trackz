import type { Metadata } from "next";

import { navPageTitle } from "@/components/shell/nav-items";

/**
 * Server-side half of the one title helper: `export const metadata =
 * pageMetadata("/production/jars")` yields "Bottling · Stock", and the root
 * layout's template appends the brand. The label comes from `NAV_ITEMS`, so
 * a page cannot carry a title the navigation does not use.
 */
export function pageMetadata(href: string, fallback?: string): Metadata {
  const title = navPageTitle(href) ?? fallback;
  if (!title) {
    throw new Error(`pageMetadata: ${href} is not in NAV_ITEMS and has no fallback`);
  }
  return { title };
}
