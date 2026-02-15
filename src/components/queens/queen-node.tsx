"use client";

import { Handle, Position } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { QUEEN_COLOR_HEX, getQueenColorForDate } from "@/lib/queen-colors";

interface QueenNodeData {
  label: string;
  hiveName: string | null;
  apiaryName: string | null;
  origin: string;
  status: string;
  introducedDate: Date | null;
  [key: string]: unknown;
}

export function QueenNode({ data }: { data: QueenNodeData }) {
  const color = getQueenColorForDate(data.introducedDate);
  const colorHex = color ? QUEEN_COLOR_HEX[color] : "#94A3B8";

  const statusColors: Record<string, string> = {
    active: "bg-green-500/10 text-green-700",
    superseded: "bg-gray-500/10 text-gray-700",
    dead: "bg-red-500/10 text-red-700",
    missing: "bg-yellow-500/10 text-yellow-700",
  };

  return (
    <div className="bg-card border rounded-lg p-3 min-w-[160px] shadow-sm">
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-2 mb-1">
        <div
          className="w-4 h-4 rounded-full border flex-shrink-0"
          style={{ backgroundColor: colorHex }}
          title={
            color
              ? `${color} (${data.introducedDate ? new Date(data.introducedDate).getFullYear() : "?"})`
              : "Unknown year"
          }
        />
        <span className="font-medium text-sm">{data.label}</span>
      </div>
      {data.hiveName && (
        <p className="text-xs text-muted-foreground">
          {data.apiaryName} &mdash; {data.hiveName}
        </p>
      )}
      <div className="flex items-center gap-2 mt-1">
        <Badge
          variant="outline"
          className={`text-xs ${statusColors[data.status] || ""}`}
        >
          {data.status}
        </Badge>
        <span className="text-xs text-muted-foreground">{data.origin}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
