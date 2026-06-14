"use client";

import type { ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

interface SettingsSectionProps {
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function SettingsSection({
  title,
  description,
  icon: Icon,
  children,
  defaultOpen = false,
}: SettingsSectionProps) {
  return (
    <details
      className="group border rounded-lg bg-card"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 p-4">
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t p-4 md:p-5">{children}</div>
    </details>
  );
}
