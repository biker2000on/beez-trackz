"use client";

import * as React from "react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  useCloseFeeding,
  useRefillFeeding,
} from "@/features/feedings/hooks";

/**
 * The two field actions that resolve a feeder row, straight from the
 * dashboard: refill it (which closes the old record and opens one successor)
 * or close it. Both make the active-feeder rule explicit, so a hive can never
 * accumulate a second ambiguous status row.
 */
export function FeedingQuickActions({
  feedingId,
  hiveName,
  unverified = false,
}: {
  feedingId: string;
  hiveName: string | null;
  unverified?: boolean;
}) {
  const refill = useRefillFeeding();
  const close = useCloseFeeding();
  const busy = refill.isPending || close.isPending;
  const where = hiveName ? ` on ${hiveName}` : "";

  const run = React.useCallback(
    async (task: Promise<unknown>, success: string) => {
      try {
        await task;
        toast.success(success);
      } catch (error) {
        toast.error(
          error instanceof ApiError ? error.message : "Could not update the feeder",
        );
      }
    },
    [],
  );

  return (
    <div className="flex shrink-0 gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() =>
          void run(
            refill.mutateAsync({ id: feedingId }),
            `Feeder${where} refilled`,
          )
        }
      >
        Refill
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() =>
          void run(
            close.mutateAsync({
              id: feedingId,
              reason: unverified ? "verified_closed" : "emptied",
            }),
            `Feeder${where} closed`,
          )
        }
      >
        Close
      </Button>
    </div>
  );
}
