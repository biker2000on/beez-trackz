"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * Apiary layout canvas — public entry point.
 *
 * The apiary detail page already imports this with next/dynamic ssr:false,
 * but react-konva depends on browser-only APIs (canvas, window), so the
 * Konva stage is loaded client-side here as well as a guard.
 */
const CanvasRoot = dynamic(() => import("./canvas-root"), {
  ssr: false,
  loading: () => <Skeleton className="h-[400px] w-full rounded-lg" />,
});

export default function ApiaryCanvas({ apiaryId }: { apiaryId: string }) {
  return <CanvasRoot apiaryId={apiaryId} />;
}
