"use client";

/**
 * Shared section navigation for route-based modules (Honey, Reports).
 *
 * Desktop and tablet get a pill link bar; small screens get a select. The
 * previous per-module strips were duplicated markup and overflow-scrolled on
 * phones, hiding whichever sections didn't fit.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const router = useRouter();
  const active = activeSection(sections, rootHref, pathname);
  const selectSections = mobileSections ?? sections;
  const selectRoot = mobileRootHref ?? rootHref;
  const selectActive = mobileSections
    ? activeSection(selectSections, selectRoot, pathname)
    : active;

  return (
    <nav aria-label={label} className="min-w-0">
      <div className="md:hidden">
        <Select
          value={selectActive?.href ?? selectRoot}
          onValueChange={(href) => router.push(`${href}${hrefSuffix}`)}
        >
          <SelectTrigger aria-label={label} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {selectSections.map((section) => (
              <SelectItem key={section.href} value={section.href}>
                {section.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ul className="hidden items-center gap-1 rounded-lg bg-muted p-1 md:inline-flex">
        {sections.map((section) => {
          const isActive = section.href === active?.href;
          return (
            <li key={section.href}>
              <Link
                href={`${section.href}${hrefSuffix}`}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex items-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
