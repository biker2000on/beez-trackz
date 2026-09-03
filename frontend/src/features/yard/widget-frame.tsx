"use client";

import type { LucideIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shared dashboard widget chrome: icon + title header, then either a
 * skeleton (loading), an error line, or the widget body.
 */
export function WidgetFrame({
  title,
  icon: Icon,
  isLoading,
  isError,
  action,
  children,
}: {
  title: string;
  icon: LucideIcon;
  isLoading: boolean;
  isError: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 text-primary" />
          {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="flex-1 pt-0">
        {isLoading ? (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            Could not load this widget.
          </p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
