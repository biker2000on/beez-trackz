"use client";

import { RecommendationCard } from "./recommendation-card";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { runRecommendationCheck } from "@/actions/recommendations";
import { useActionState } from "react";

interface Recommendation {
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
}

interface RecommendationListProps {
  recommendations: Recommendation[];
  hiveNames?: Record<string, string>;
}

export function RecommendationList({
  recommendations,
  hiveNames = {},
}: RecommendationListProps) {
  const [_state, checkAction, isPending] = useActionState(
    async () => {
      await runRecommendationCheck();
      return null;
    },
    null
  );

  // Sort by priority (urgent first)
  const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
  const sorted = [...recommendations].sort((a, b) => {
    const aPriority =
      priorityOrder[a.priority as keyof typeof priorityOrder] ?? 4;
    const bPriority =
      priorityOrder[b.priority as keyof typeof priorityOrder] ?? 4;
    return aPriority - bPriority;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Recommendations</h2>
        <form action={checkAction}>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={isPending}
          >
            <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
            Check Now
          </Button>
        </form>
      </div>

      {sorted.length === 0 ? (
        <div className="text-center py-12 bg-card rounded-lg border">
          <p className="text-muted-foreground">
            No recommendations. Your hives are in good shape!
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((rec) => (
            <RecommendationCard
              key={rec.id}
              recommendation={rec}
              hiveName={rec.hiveId ? hiveNames[rec.hiveId] : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
