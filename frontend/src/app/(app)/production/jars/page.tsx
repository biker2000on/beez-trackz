import type { Metadata } from "next";
import Link from "next/link";

import { JarsTab } from "@/features/honey/jars-tab";

export const metadata: Metadata = { title: "Jars" };

export default function JarsPage() {
  return (
    <div className="mx-auto grid w-full max-w-none gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Jars</h1>
          <p className="text-sm text-muted-foreground">
            Packaged stock on hand, derived from the honey ledger.
          </p>
        </div>
        {/* The size catalog has one editor, and it is not here (design
            2026-09-03 S13). Plain styled Link: this is a server component,
            and ui/button pulls Radix Slot (createContext), which cannot load
            in an RSC. */}
        <Link
          href="/admin/setup#jar-sizes"
          className="inline-flex h-8 w-fit items-center rounded-md border bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Manage jar sizes
        </Link>
      </div>
      <JarsTab />
    </div>
  );
}
