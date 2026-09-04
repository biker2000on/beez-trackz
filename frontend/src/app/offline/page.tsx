"use client";

import Link from "next/link";
import { CloudOff, RefreshCw } from "lucide-react";

import { LogoMark } from "@/components/logo";
import { useBrand } from "@/components/brand-provider";
import { Button } from "@/components/ui/button";

export default function OfflinePage() {
  const brand = useBrand();

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-center">
      <div className="grid max-w-sm justify-items-center gap-4">
        {/* Sole product identity on this page, so it gets an accessible name. */}
        <LogoMark className="size-16" label={brand.displayName} />
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
            Go to cached Today
          </Link>
        </Button>
      </div>
    </main>
  );
}
