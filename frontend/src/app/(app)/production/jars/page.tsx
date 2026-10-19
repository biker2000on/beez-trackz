import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { JarsTab } from "@/features/honey/jars-tab";
import { pageMetadata } from "@/lib/page-title";

export const metadata = pageMetadata("/production/jars");

export default function JarsPage() {
  return (
    <div className="mx-auto grid w-full max-w-none gap-4">
      {/* The size catalog has one editor, and it is not here (design
          2026-09-03 S13). Plain styled Link: this is a server component,
          and ui/button pulls Radix Slot (createContext), which cannot load
          in an RSC. */}
      <PageHeader
        subtitle="Bottle bulk honey into jars and keep the packaged count right."
        actions={
          <Link
            href="/admin/setup#jar-sizes"
            className="inline-flex h-9 w-fit items-center rounded-md border bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            Manage jar sizes
          </Link>
        }
      />
      <JarsTab />
    </div>
  );
}
