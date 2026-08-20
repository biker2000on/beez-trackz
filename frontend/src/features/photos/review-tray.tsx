"use client";

import { Check, MapPinOff, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import {
  useReviewTimelinePhoto,
  type TimelineCandidate,
} from "./hooks";

const reasonLabels: Record<string, string> = {
  missing_gps: "No EXIF location — smart-search match only",
  multiple_apiaries: "Inside more than one yard's forage radius",
  flora_or_bees_needs_review: "Flora or bee match needs a human check",
  no_longer_matched: "Not found by the latest scan",
  rendition_enqueue_failed: "Thumbnail processing needs another attempt",
};

function candidateDate(value: string | null) {
  if (!value) return "Taken date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function TimelineReviewTray({
  apiaryId,
  candidates,
}: {
  apiaryId: string;
  candidates: TimelineCandidate[];
}) {
  const review = useReviewTimelinePhoto(apiaryId);

  async function decide(candidateId: string, action: "adopt" | "reject") {
    try {
      await review.mutateAsync({ candidateId, action });
      toast.success(action === "adopt" ? "Photo added to timeline" : "Match dismissed");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not review photo");
    }
  }

  if (candidates.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review Immich matches</CardTitle>
        <p className="text-sm text-muted-foreground">
          These matches are ambiguous. Nothing here is attached until you choose it.
        </p>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {candidates.map((candidate) => (
          <article key={candidate.id} className="overflow-hidden rounded-lg border">
            <div className="aspect-[4/3] bg-muted">
              {/* This is an authenticated API proxy, not a browser Immich URL. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={candidate.thumbnailUrl}
                alt={candidate.originalFilename ?? "Immich review candidate"}
                className="size-full object-cover"
                loading="lazy"
              />
            </div>
            <div className="grid gap-2 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {candidate.originalFilename ?? "Untitled Immich photo"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {candidateDate(candidate.takenDate)}
                </p>
              </div>
              <p className="flex gap-1.5 text-xs text-muted-foreground">
                <MapPinOff className="mt-0.5 size-3.5 shrink-0" />
                {reasonLabels[candidate.reviewReason] ?? "Needs review"}
              </p>
              {candidate.matchedTerms.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Matched: {candidate.matchedTerms.join(", ")}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={review.isPending}
                  onClick={() => void decide(candidate.id, "adopt")}
                >
                  <Check />
                  Attach
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={review.isPending}
                  onClick={() => void decide(candidate.id, "reject")}
                >
                  <X />
                  Dismiss
                </Button>
              </div>
            </div>
          </article>
        ))}
      </CardContent>
    </Card>
  );
}
