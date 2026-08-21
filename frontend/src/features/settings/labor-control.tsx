"use client";

import * as React from "react";
import { toast } from "sonner";

import { ApiError, OfflineQueuedError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

import {
  useApiaryOptions,
  useLaborCurrent,
  useLaborList,
  useLaborStart,
  useLaborStop,
} from "./api";

const NONE = "none";

function formatElapsed(startedAt: string, now: number): string {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "0m";
  const minutes = Math.max(0, Math.round((now - started) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours <= 0) return `${rem}m`;
  return `${hours}h ${rem}m`;
}

/**
 * Start/stop control for a yard visit. Off until Settings > Preferences
 * enables labor minutes. Import this onto the yard-queue page as well.
 */
export function LaborControl({ quietWhenOff = false }: { quietWhenOff?: boolean } = {}) {
  const current = useLaborCurrent();
  const list = useLaborList();
  const apiaries = useApiaryOptions();
  const start = useLaborStart();
  const stop = useLaborStop();
  const [apiaryId, setApiaryId] = React.useState<string>(NONE);
  const [now, setNow] = React.useState(() => Date.now());
  const running = current.data?.current?.open === true;

  React.useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (current.isPending) {
    if (quietWhenOff) return null;
    return <Skeleton className="h-24 w-full" />;
  }
  if (current.isError || !current.data) {
    if (quietWhenOff) return null;
    return (
      <p className="text-sm text-muted-foreground">
        Could not load labor tracking.
      </p>
    );
  }
  if (!current.data.enabled) {
    if (quietWhenOff) return null;
    return (
      <p className="text-sm text-muted-foreground">
        Labor minutes are off. Enable them under Preferences if you want
        start/stop on a yard visit.
      </p>
    );
  }

  const session = current.data.current;
  const recent = (list.data?.items ?? []).slice(0, 8);

  return (
    <div className="grid gap-4">
      {session?.open ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
          <div>
            <p className="font-medium">Yard visit running</p>
            <p className="text-sm text-muted-foreground">
              {session.apiaryName ?? "All yards"} ·{" "}
              {formatElapsed(session.startedAt, now)}
            </p>
          </div>
          <Button
            type="button"
            disabled={stop.isPending}
            onClick={() =>
              stop.mutate(
                { id: session.id },
                {
                  onSuccess: (stopped) =>
                    toast.success(`Stopped at ${stopped.minutes} min`),
                  onError: (error) => {
                    if (error instanceof OfflineQueuedError) {
                      toast.message("Stop saved offline — syncs on reconnect");
                      return;
                    }
                    toast.error(
                      error instanceof ApiError
                        ? error.message
                        : "Could not stop labor",
                    );
                  },
                },
              )
            }
          >
            Stop
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-48 flex-1 gap-2">
            <span className="text-sm font-medium">Yard</span>
            <Select value={apiaryId} onValueChange={setApiaryId}>
              <SelectTrigger aria-label="Labor apiary">
                <SelectValue placeholder="All yards" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>All yards</SelectItem>
                {(apiaries.data ?? []).map((apiary) => (
                  <SelectItem key={apiary.id} value={apiary.id}>
                    {apiary.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            disabled={start.isPending}
            onClick={() =>
              start.mutate(
                { apiaryId: apiaryId === NONE ? null : apiaryId },
                {
                  onSuccess: () => toast.success("Yard visit started"),
                  onError: (error) => {
                    if (error instanceof OfflineQueuedError) {
                      toast.message("Start saved offline — syncs on reconnect");
                      return;
                    }
                    toast.error(
                      error instanceof ApiError
                        ? error.message
                        : "Could not start labor",
                    );
                  },
                },
              )
            }
          >
            Start
          </Button>
        </div>
      )}

      {recent.length > 0 ? (
        <ul className="grid gap-1 text-sm">
          {recent.map((item) => (
            <li
              key={item.id}
              className="flex justify-between gap-3 text-muted-foreground"
            >
              <span>
                {item.apiaryName ?? "All yards"} ·{" "}
                {new Date(item.startedAt).toLocaleString()}
              </span>
              <span className="font-medium text-foreground">
                {item.open ? "running" : `${item.minutes} min`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
