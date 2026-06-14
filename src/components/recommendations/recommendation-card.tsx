"use client";

import { useServerActionForm } from "@/components/forms/use-server-action-form";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ClipboardCheck,
  Pill,
  Wrench,
  Calendar,
  Droplets,
  X,
} from "lucide-react";
import Link from "next/link";
import { dismissRecommendation } from "@/actions/recommendations";


interface RecommendationCardProps {
  recommendation: {
    id: string;
    hiveId: string | null;
    type:
      | "inspection_due"
      | "treatment_reminder"
      | "equipment_needed"
      | "seasonal_prep"
      | "feeder_check";
    message: string;
    priority: string;
    createdAt: Date;
  };
  hiveName?: string;
}

const typeIcons = {
  inspection_due: ClipboardCheck,
  treatment_reminder: Pill,
  equipment_needed: Wrench,
  seasonal_prep: Calendar,
  feeder_check: Droplets,
} as const;

const priorityStyles = {
  urgent: "border-red-500 bg-red-50",
  high: "border-orange-500 bg-orange-50",
  normal: "border-blue-500 bg-blue-50",
  low: "border-gray-300 bg-gray-50",
} as const;

const priorityBadgeStyles = {
  urgent: "bg-red-100 text-red-800 border-red-300",
  high: "bg-orange-100 text-orange-800 border-orange-300",
  normal: "bg-blue-100 text-blue-800 border-blue-300",
  low: "bg-gray-100 text-gray-600 border-gray-300",
} as const;

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(date).toLocaleDateString();
}

export function RecommendationCard({
  recommendation,
  hiveName,
}: RecommendationCardProps) {
  const [_state, dismissAction, isPending] = useServerActionForm(
    async () => {
      await dismissRecommendation(recommendation.id);
      return null;
    },
    null
  );

  const Icon = typeIcons[recommendation.type];
  const priorityKey = recommendation.priority as keyof typeof priorityStyles;
  const cardStyle = priorityStyles[priorityKey] || priorityStyles.normal;
  const badgeStyle =
    priorityBadgeStyles[priorityKey] || priorityBadgeStyles.normal;

  const content = (
    <Card className={`border-l-4 ${cardStyle} transition-opacity ${isPending ? "opacity-50" : ""}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <Icon className="h-5 w-5 mt-0.5 flex-shrink-0 text-gray-700" />

            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={badgeStyle}>
                  {recommendation.priority}
                </Badge>
                {hiveName && (
                  <span className="text-xs text-muted-foreground">
                    {hiveName}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {formatTimeAgo(recommendation.createdAt)}
                </span>
              </div>

              <p className="text-sm text-gray-900">{recommendation.message}</p>
            </div>
          </div>

          <form onSubmit={dismissAction}>
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              className="flex-shrink-0 h-8 w-8"
              disabled={isPending}
            >
              <X className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );

  if (recommendation.hiveId) {
    return (
      <Link href={`/hives/${recommendation.hiveId}`} className="block">
        {content}
      </Link>
    );
  }

  return content;
}
