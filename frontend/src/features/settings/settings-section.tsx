"use client";

import * as React from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/**
 * Collapsible settings card. Content stays mounted while collapsed so form
 * drafts (and the install-prompt listener) survive toggling.
 *
 * `anchor` is what the contextual "manage" links from Production, Sales,
 * Equipment and the lockout item aim at (design 2026-09-03 §6.2): arriving at
 * `/admin/setup#jar-sizes` opens that section rather than dropping the
 * operator on a page of closed cards.
 */
export function SettingsSection({
  title,
  description,
  icon: Icon,
  anchor,
  defaultOpen = true,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  anchor?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  // The hash is browser-only, so it is subscribed to rather than read during
  // render: the server snapshot is "" and the first client snapshot is the
  // real hash, which is exactly what `useSyncExternalStore` is for.
  const hash = React.useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash,
    () => "",
  );
  const targeted = anchor != null && hash === `#${anchor}`;
  // null until the operator touches the header; after that their click wins
  // over both the anchor and the default.
  const [toggled, setToggled] = React.useState<boolean | null>(null);
  const open = toggled ?? (targeted || defaultOpen);
  const contentId = React.useId();

  return (
    <Card id={anchor}>
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-t-xl p-5 text-left transition-colors hover:bg-muted/40"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setToggled(!open)}
      >
        <Icon className="size-5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold leading-none tracking-tight">
            {title}
          </span>
          <span className="mt-1.5 block text-sm text-muted-foreground">
            {description}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      <CardContent id={contentId} className={cn("pt-1", !open && "hidden")}>
        {children}
      </CardContent>
    </Card>
  );
}
