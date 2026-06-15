"use client";

import dynamic from "next/dynamic";
import type { CanvasHive, CanvasLayout } from "@/lib/canvas/types";

// Dynamically import the canvas inner component to avoid SSR issues with react-konva.
// react-konva depends on browser APIs (canvas, window) that are unavailable on the server.
const CanvasInner = dynamic(
  () => import("./canvas-inner").then((mod) => ({ default: mod.CanvasInner })),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-[400px] border rounded-lg bg-stone-50">
        <p className="text-muted-foreground">Loading canvas...</p>
      </div>
    ),
  }
);

interface ApiaryCanvasProps {
  apiaryId: string;
  apiaryName: string;
  hives: CanvasHive[];
  initialLayout: CanvasLayout | null;
  latitude?: number | null;
  longitude?: number | null;
}

export function ApiaryCanvas({
  apiaryId,
  apiaryName,
  hives,
  initialLayout,
  latitude,
  longitude,
}: ApiaryCanvasProps) {
  return (
    <CanvasInner
      apiaryId={apiaryId}
      apiaryName={apiaryName}
      hives={hives}
      initialLayout={initialLayout}
      latitude={latitude}
      longitude={longitude}
    />
  );
}
