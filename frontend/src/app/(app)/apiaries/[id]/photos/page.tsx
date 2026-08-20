import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { ApiarySubpage } from "@/features/apiaries/subpage";

export const metadata: Metadata = { title: "Apiary photos" };

export default async function ApiaryPhotosPage({ params }: PageProps<"/apiaries/[id]/photos">) {
  const { id } = await params;
  return (
    <div className="grid gap-4">
      <Button asChild variant="outline" size="sm" className="w-fit justify-self-end">
        <Link href={`/apiaries/${id}/timeline`}>Open yard timeline</Link>
      </Button>
      <ApiarySubpage apiaryId={id} section="photos" />
    </div>
  );
}
