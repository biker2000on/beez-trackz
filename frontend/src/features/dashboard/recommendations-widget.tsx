"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useRecommendations } from "./hooks";
import { WidgetFrame } from "./widget-frame";

export const PRIORITY_BADGE: Record<string, string> = {
  urgent: "border-transparent bg-destructive text-destructive-foreground",
  high: "border-transparent bg-primary/20 text-primary",
  normal: "border-transparent bg-secondary text-secondary-foreground",
  low: "text-muted-foreground",
};

export function RecommendationsWidget() {
  const recommendations = useRecommendations();
  const list = recommendations.data ?? [];
  const top = list.slice(0, 3);
  const extra = list.length - top.length;

  return (
    <WidgetFrame
      title="Recommendations"
      icon={Sparkles}
      isLoading={recommendations.isPending}
      isError={recommendations.isError}
    >
      {top.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing needs attention right now.
        </p>
      ) : (
        <ul className="grid gap-2.5">
          {top.map((rec) => (
            <li key={rec.id} className="flex items-start gap-2">
              <Badge
                variant="outline"
                className={cn("mt-0.5", PRIORITY_BADGE[rec.priority])}
              >
                {rec.priority}
              </Badge>
              <div className="min-w-0 text-sm">
                <p className="line-clamp-2">{rec.message}</p>
                {rec.hiveName && (
                  <p className="text-xs text-muted-foreground">
                    {rec.hiveName}
                  </p>
                )}
              </div>
            </li>
          ))}
          {extra > 0 && (
            <li>
              <Link
                href="/recommendations"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                +{extra} more
              </Link>
            </li>
          )}
        </ul>
      )}
    </WidgetFrame>
  );
}
