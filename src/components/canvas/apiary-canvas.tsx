"use client";

import dynamic from "next/dynamic";
import type { CanvasLayout } from "@/actions/canvas";

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

interface Hive {
  id: string;
  positionLabel: string;
  status: string;
}

interface ApiaryCanvasProps {
  apiaryId: string;
  hives: Hive[];
  initialLayout: CanvasLayout | null;
}

export function ApiaryCanvas({
  apiaryId,
  hives,
  initialLayout,
}: ApiaryCanvasProps) {
  if (hives.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px] border rounded-lg bg-stone-50">
        <p className="text-muted-foreground">
          Add hives to this apiary to use the canvas layout.
        </p>
      </div>
    );
  }

  return (
    <CanvasInner
      apiaryId={apiaryId}
      hives={hives}
      initialLayout={initialLayout}
    />
  );
}
