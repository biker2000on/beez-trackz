import type { Metadata } from "next";
import Link from "next/link";

import { ApiarySubpage } from "@/features/apiaries/subpage";

export const metadata: Metadata = { title: "Apiary photos" };

export default async function ApiaryPhotosPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="grid gap-4">
      {/* Plain styled Link: this is a server component, and ui/button pulls
          Radix Slot (createContext) which cannot load in an RSC. */}
      <Link
        href={`/yard/apiaries/${id}/timeline`}
        className="inline-flex h-8 w-fit items-center justify-self-end rounded-md border bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        Open yard timeline
      </Link>
      <ApiarySubpage apiaryId={id} section="photos" />
    </div>
  );
}
