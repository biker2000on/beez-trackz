"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DeleteButton } from "@/components/shared/delete-button";
import {
  endBloom,
  updateBloomLastSeen,
  deleteBloomObservation,
} from "@/actions/bloom-observations";

interface Bloom {
  id: string;
  species: string;
  dateFirstSeen: string;
  abundance: number | null;
  apiaryId: string;
}

interface ActiveBloomsProps {
  blooms: Bloom[];
  apiaryId: string;
}

const abundanceLabels: Record<number, string> = {
  1: "Sparse",
  2: "Light",
  3: "Moderate",
  4: "Heavy",
  5: "Abundant",
};

export function ActiveBlooms({ blooms, apiaryId }: ActiveBloomsProps) {
  const [isPending, startTransition] = useTransition();

  if (blooms.length === 0) {
    return (
      <p className="text-muted-foreground text-sm text-center py-4">
        No active blooms recorded. Add one when you spot something flowering.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {blooms.map((bloom) => (
        <div
          key={bloom.id}
          className="flex items-center justify-between py-2 px-3 border rounded-md"
        >
          <div>
            <span className="font-medium">{bloom.species}</span>
            <span className="text-muted-foreground text-sm ml-2">
              since {new Date(bloom.dateFirstSeen).toLocaleDateString()}
            </span>
            {bloom.abundance && (
              <Badge variant="secondary" className="ml-2">
                {abundanceLabels[bloom.abundance] || bloom.abundance}
              </Badge>
            )}
          </div>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() =>
                startTransition(() => updateBloomLastSeen(bloom.id, apiaryId))
              }
            >
              Still Blooming
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() =>
                startTransition(() => endBloom(bloom.id, apiaryId))
              }
            >
              End Bloom
            </Button>
            <DeleteButton
              onDelete={async () => {
                await deleteBloomObservation(bloom.id, apiaryId);
              }}
              entityName="Bloom Observation"
            />
          </div>
        </div>
      ))}
    </div>
  );
}
