"use client";

import { useRouter } from "next/navigation";
import { useShortcut } from "./shortcut-provider";

/**
 * Declarative page-level navigation shortcut for server components:
 * renders nothing, registers `keys` to push `href` while mounted.
 */
export function NavShortcut({
  keys,
  href,
  description,
  group = "This page",
}: {
  keys: string;
  href: string;
  description: string;
  group?: string;
}) {
  const router = useRouter();
  useShortcut(keys, description, group, () => router.push(href));
  return null;
}
