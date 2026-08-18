"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ClipboardList,
  Droplets,
  Hexagon,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { useYardQueue, type YardQueueItem } from "./hooks";

const KIND_META: Record<
  YardQueueItem["kind"],
  { label: string; icon: typeof ClipboardList; className: string }
> = {
  lockout: {
    label: "Lockout",
    icon: AlertTriangle,
    className: "border-amber-500/40 bg-amber-500/10",
  },
  recommendation: {
    label: "Rec",
    icon: Sparkles,
    className: "",
  },
  feeding: {
    label: "Feed",
    icon: Droplets,
    className: "",
  },
  harvest_ready: {
    label: "Harvest",
    icon: Hexagon,
    className: "border-primary/30 bg-primary/5",
  },
};

export function YardQueuePage() {
  const queue = useYardQueue();

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Yard queue</h1>
        <p className="text-sm text-muted-foreground">
          Saturday work: open recs, honey that is ready, feeders that need a
          look, and lockout end dates. Cached for offline walks.
        </p>
      </div>

      {queue.isPending ? (
        <div className="grid gap-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : queue.isError ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Could not load the yard queue.{" "}
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => void queue.refetch()}
          >
            Try again
          </button>
        </p>
      ) : queue.data.yards.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nothing queued. Open recommendations, harvest-ready supers, and
            empty feeders will land here.
          </CardContent>
        </Card>
      ) : (
        queue.data.yards.map((yard) => (
          <section key={yard.apiaryId} className="grid gap-2">
            <h2 className="text-sm font-semibold">{yard.apiaryName}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {yard.items.map((item, index) => (
                <QueueRow key={`${item.kind}:${item.hiveId ?? item.title}:${index}`} item={item} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function QueueRow({ item }: { item: YardQueueItem }) {
  const meta = KIND_META[item.kind] ?? KIND_META.recommendation;
  const Icon = meta.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex min-h-20 items-start gap-3 rounded-xl border bg-card p-4 shadow-sm active:bg-muted/60",
        meta.className,
      )}
    >
      <Icon className="mt-0.5 size-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 grid gap-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="font-medium leading-tight">{item.title}</p>
          <Badge variant="outline" className="text-[10px] uppercase">
            {meta.label}
          </Badge>
        </div>
        {item.hiveName && (
          <p className="text-sm font-medium text-foreground/80">{item.hiveName}</p>
        )}
        <p className="text-xs text-muted-foreground">{item.detail}</p>
      </div>
    </Link>
  );
}

export function YardQueueLink() {
  return (
    <Button asChild size="sm" variant="outline">
      <Link href="/operations/yard-queue">
        <ClipboardList />
        Yard queue
      </Link>
    </Button>
  );
}
