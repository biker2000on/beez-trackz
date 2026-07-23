"use client";

import * as React from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Collapsible settings card. Content stays mounted while collapsed so form
 * drafts (and the install-prompt listener) survive toggling.
 */
export function SettingsSection({
  title,
  description,
  icon: Icon,
  defaultOpen = true,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const contentId = React.useId();

  return (
    <Card>
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-t-xl p-5 text-left transition-colors hover:bg-muted/40"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((v) => !v)}
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
