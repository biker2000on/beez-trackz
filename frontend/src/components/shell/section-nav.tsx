"use client";

/**
 * Shared section navigation for route-based modules (Honey, Reports).
 *
 * Desktop and tablet get a pill link bar; small screens get a select. The
 * previous per-module strips were duplicated markup and overflow-scrolled on
 * phones, hiding whichever sections didn't fit.
 */

import Link from "next/link";
import { cn } from "@/lib/utils";

export interface SectionLink {
  href: string;
  label: string;
  /** Additional route prefixes represented by this section. */
  matches?: readonly string[];
}

/** The section whose href best matches the pathname (root needs an exact match). */
export function activeSection(
  sections: readonly SectionLink[],
  rootHref: string,
  pathname: string,
): SectionLink | undefined {
  let best: SectionLink | undefined;
  for (const section of sections) {
    if (
      section.matches?.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
      )
    ) {
      return section;
    }
    if (section.href === rootHref) {
      if (pathname === rootHref) return section;
      continue;
    }
    if (
      pathname.startsWith(section.href) &&
      (!best || section.href.length > best.href.length)
    ) {
      best = section;
    }
  }
  return best;
}

export function SectionNav({
  label,
  sections,
  rootHref,
  pathname,
  hrefSuffix = "",
  mobileSections,
  mobileRootHref,
}: {
  /** Accessible name for the nav, e.g. "Honey sections". */
  label: string;
  sections: readonly SectionLink[];
  /** The module root — active only on an exact pathname match. */
  rootHref: string;
  pathname: string;
  /** Query string carried on every link (e.g. "?year=2026"). */
  hrefSuffix?: string;
  /** Flattened destinations for the small-screen select (report-to-report). */
  mobileSections?: readonly SectionLink[];
  mobileRootHref?: string;
}) {
  const active = activeSection(sections, rootHref, pathname);
  const mobile = mobileSections ?? sections;
  const mobileActive = activeSection(mobile, mobileRootHref ?? rootHref, pathname);
  const links = (items: readonly SectionLink[], selected: SectionLink | undefined) => (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {items.map((section) => <li key={section.href}><Link href={`${section.href}${hrefSuffix}`} aria-current={section.href === selected?.href ? "page" : undefined} className={cn("inline-flex min-h-11 items-center border-b-2 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", section.href === selected?.href ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{section.label}</Link></li>)}
    </ul>
  );
  return <nav aria-label={label} className="min-w-0 border-b">
    <details className="md:hidden"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">Pages · {mobileActive?.label ?? "Choose page"}</summary>{links(mobile, mobileActive)}</details>
    <div className="hidden md:block">{links(sections, active)}</div>
  </nav>;
}
