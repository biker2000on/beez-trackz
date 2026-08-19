"use client";

import { CloudOff, RefreshCw, TriangleAlert } from "lucide-react";
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type QueueStatus = {
  pending: number;
  conflicts: number;
  failed: number;
  needsAuth: boolean;
  items: Array<{
    id: string;
    method: string;
    path: string;
    queuedAt: string;
    state: "pending" | "conflict" | "failed";
    error: string | null;
  }>;
};

const emptyStatus: QueueStatus = {
  pending: 0,
  conflicts: 0,
  failed: 0,
  needsAuth: false,
  items: [],
};

export function PwaRegister() {
  const online = React.useSyncExternalStore(
    React.useCallback((notify) => {
      window.addEventListener("online", notify);
      window.addEventListener("offline", notify);
      return () => {
        window.removeEventListener("online", notify);
        window.removeEventListener("offline", notify);
      };
    }, []),
    () => navigator.onLine,
    () => true,
  );
  const [queue, setQueue] = React.useState<QueueStatus>(emptyStatus);
  const [reviewOpen, setReviewOpen] = React.useState(false);

  React.useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const send = (type: string) => {
      navigator.serviceWorker.controller?.postMessage({ type });
    };
    const onOnline = () => {
      send("REPLAY_OFFLINE_QUEUE");
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "OFFLINE_QUEUE_STATUS") {
        setQueue({
          pending: event.data.pending ?? 0,
          conflicts: event.data.conflicts ?? 0,
          failed: event.data.failed ?? 0,
          needsAuth: Boolean(event.data.needsAuth),
          items: event.data.items ?? [],
        });
      }
    };
    const register = async () => {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
      });
      await navigator.serviceWorker.ready;
      (registration.active ?? navigator.serviceWorker.controller)?.postMessage({
        type: "GET_OFFLINE_QUEUE_STATUS",
      });
    };

    window.addEventListener("online", onOnline);
    navigator.serviceWorker.addEventListener("message", onMessage);
    if (document.readyState === "complete") void register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      window.removeEventListener("load", register);
      window.removeEventListener("online", onOnline);
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  const issues = queue.conflicts + queue.failed;
  const queued = queue.pending + issues;
  // Connectivity-only offline is the top OfflineBanner. This slot is the
  // queue: pending replay, conflicts, or failed writes.
  if (queued === 0) return null;

  const sendMutationAction = (type: string, id: string) =>
    navigator.serviceWorker.controller?.postMessage({ type, id });

  return (
    <>
      {/* data-offline-banner marks the bottom banner slot as taken, so the
          install prompt stands down while sync work is reported here. */}
      <div
      data-offline-banner=""
      className="fixed inset-x-3 bottom-[calc(var(--bottom-nav-h)+0.75rem)] z-[100] mx-auto flex max-w-lg items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-lg lg:bottom-3 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50"
      role="status"
    >
      {issues > 0 ? (
        <TriangleAlert className="size-5 shrink-0" />
      ) : (
        <CloudOff className="size-5 shrink-0" />
      )}
      <span className="flex-1">
        {queue.needsAuth
          ? `Sign in to sync ${queue.pending} queued change${queue.pending === 1 ? "" : "s"}`
          : !online
            ? `Offline${queue.pending ? ` · ${queue.pending} change${queue.pending === 1 ? "" : "s"} queued` : ""}`
            : issues
              ? `${issues} offline change${issues === 1 ? "" : "s"} need review`
              : `Syncing ${queue.pending} queued change${queue.pending === 1 ? "" : "s"}…`}
      </span>
      {queue.needsAuth ? (
        <a
          href="/login"
          className="rounded-md px-2 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-900"
        >
          Sign in
        </a>
      ) : issues > 0 ? (
        <button
          className="rounded-md px-2 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-900"
          onClick={() => setReviewOpen(true)}
          type="button"
        >
          Review
        </button>
      ) : online && queue.pending > 0 ? (
        <button
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-900"
          onClick={() =>
            navigator.serviceWorker.controller?.postMessage({
              type: "REPLAY_OFFLINE_QUEUE",
            })
          }
          type="button"
        >
          <RefreshCw className="size-3.5" />
          Retry
        </button>
      ) : null}
      </div>
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Offline changes needing review</DialogTitle>
            <DialogDescription>
              A conflict means the server record changed after this edit was
              queued. Nothing here can overwrite the newer server version:
              retry re-sends the change with its original queue time, so it
              only lands if the record is no longer newer. Otherwise discard
              the local change.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[55dvh] divide-y overflow-y-auto rounded-lg border">
            {queue.items
              .filter((item) => item.state !== "pending")
              .map((item) => (
                <div
                  className="grid gap-2 p-3"
                  data-queue-state={item.state}
                  key={item.id}
                >
                  <div className="flex items-center justify-between gap-3">
                    <code className="truncate text-xs">
                      {item.method} {item.path}
                    </code>
                    <span className="text-xs capitalize text-muted-foreground">
                      {item.state}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{item.error}</p>
                  {item.state === "conflict" ? (
                    <p className="text-xs text-muted-foreground">
                      The server version is kept until you choose. Retrying
                      cannot overwrite it.
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        sendMutationAction("DISCARD_OFFLINE_MUTATION", item.id)
                      }
                    >
                      {item.state === "conflict"
                        ? "Discard my change"
                        : "Discard"}
                    </Button>
                    <Button
                      size="sm"
                      variant={item.state === "conflict" ? "outline" : "default"}
                      onClick={() =>
                        sendMutationAction("RETRY_OFFLINE_MUTATION", item.id)
                      }
                    >
                      {item.state === "conflict"
                        ? "Retry without overwriting"
                        : "Retry"}
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
