"use client";

/**
 * Section menu for the Production area. The old tab strip became real
 * routes, so this is a link bar rather than a `<Tabs>` — every section is
 * deep-linkable and back-button safe for free.
 *
 * Detail routes resolve to their parent group without changing the visible
 * navigation, so the chrome never jumps when opening Activity or a QR lookup.
 *
 * The workbench hides the menu: it is a single-read screen (design §4.8) and
 * the quick-action dialogs below would each prefetch their option lists on
 * top of the one call it is allowed to make. Sales moved out of this file
 * entirely — its nav lives in the shell now (wave 4 frontend finding 5).
 */

import { usePathname } from "next/navigation";

import { SectionNav } from "@/components/shell/section-nav";

import { HoneyQuickActions } from "./quick-actions";

export const PRODUCTION_SECTIONS = [
  {
    href: "/production",
    label: "Overview",
    matches: ["/production/activity"],
  },
  {
    href: "/production/overview",
    label: "Production",
    matches: [
      "/production/harvests",
      "/production/jars",
      "/production/lots",
      "/production/serials",
      "/production/sessions",
      "/production/products",
      // Varietals was missing here while `NAV_ITEMS` listed it, so the menu
      // de-highlighted on that one route. One nav tree, one answer.
      "/production/varietals",
    ],
  },
] as const;

export function ProductionSectionNav() {
  const pathname = usePathname();
  if (pathname.startsWith("/production/workbench")) return null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3">
      <SectionNav
        label="Production sections"
        sections={PRODUCTION_SECTIONS}
        rootHref="/production"
        pathname={pathname}
      />
      <div className="flex items-center gap-2">
        {/* The overview owns the quick-action row; on sub-routes the same six
            dialogs (and their shortcuts) live behind this menu. */}
        {pathname !== "/production" && <HoneyQuickActions variant="menu" />}
      </div>
    </div>
  );
}
