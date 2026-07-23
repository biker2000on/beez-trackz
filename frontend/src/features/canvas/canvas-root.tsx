"use client";

import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { CanvasInner } from "./canvas-inner";
import { parseCanvasLayout } from "./lib/types";
import { useApiary, useApiaryHives } from "./lib/use-canvas-data";

/**
 * Loads the apiary (canvas layout blob) and its hives (slot occupancy),
 * then mounts the canvas. The canvas keeps the layout in local state, so
 * it is keyed by apiary and only mounted once both queries have resolved.
 */
export default function CanvasRoot({ apiaryId }: { apiaryId: string }) {
  const apiary = useApiary(apiaryId);
  const hives = useApiaryHives(apiaryId);

  // Parse once per loaded apiary; refetches of the same blob are harmless
  // because CanvasInner only reads the layout for its initial state.
  const initialLayout = useMemo(
    () => (apiary.data ? parseCanvasLayout(apiary.data.canvasLayout) : null),
    [apiary.data],
  );

  if (apiary.isError || hives.isError) {
    return (
      <div className="flex h-[400px] flex-col items-center justify-center gap-3 rounded-lg border bg-muted/30">
        <p className="text-sm text-muted-foreground">
          Could not load the apiary layout.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void apiary.refetch();
            void hives.refetch();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (!apiary.data || !hives.data || !initialLayout) {
    return <Skeleton className="h-[400px] w-full rounded-lg" />;
  }

  return (
    <CanvasInner
      key={apiaryId}
      apiary={apiary.data}
      hives={hives.data}
      initialLayout={initialLayout}
    />
  );
}
