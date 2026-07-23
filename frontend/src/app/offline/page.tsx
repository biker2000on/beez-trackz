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
            Your records are safe. Reconnect before viewing data or saving
            changes so nothing is recorded out of order.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard">
            <RefreshCw />
            Try again
          </Link>
        </Button>
      </div>
    </main>
  );
}
