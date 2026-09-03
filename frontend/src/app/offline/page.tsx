"use client";

import Link from "next/link";
import { CloudOff, RefreshCw } from "lucide-react";

import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";

export default function OfflinePage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-center">
      <div className="grid max-w-sm justify-items-center gap-4">
        <LogoMark className="size-16" />
        <div className="grid justify-items-center gap-2">
          <CloudOff className="size-7 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">You’re offline</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            This page was never cached, so there is nothing to show yet. Your
            records are safe, and the field pages you already opened still work
            offline.
          </p>
        </div>
        <Button asChild>
          <Link href="/today">
            <RefreshCw />
            Go to the cached dashboard
          </Link>
        </Button>
      </div>
    </main>
  );
}
