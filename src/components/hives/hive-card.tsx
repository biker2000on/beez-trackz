"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

const statusColors: Record<string, string> = {
  active: "bg-green-500/10 text-green-700 border-green-200",
  dead: "bg-red-500/10 text-red-700 border-red-200",
  sold: "bg-blue-500/10 text-blue-700 border-blue-200",
  combined: "bg-yellow-500/10 text-yellow-700 border-yellow-200",
};

interface HiveCardProps {
  id: string;
  positionLabel: string;
  status: string;
  apiaryName: string;
  installedDate: Date | null;
  isArchived: boolean;
  selecting?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
}

export function HiveCard({
  id,
  positionLabel,
  status,
  apiaryName,
  installedDate,
  isArchived,
  selecting = false,
  selected,
  onToggle,
}: HiveCardProps) {
  const isSelected = selected?.has(id) ?? false;
  const body = (
      <Card className={`hover:border-primary/50 transition-colors cursor-pointer ${isArchived ? "opacity-50" : ""}`}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {selecting && (
                <span onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => onToggle?.(id)}
                    aria-label={`Select ${positionLabel}`}
                  />
                </span>
              )}
              <CardTitle className="text-lg">{positionLabel}</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              {isArchived && (
                <Badge variant="secondary" className="text-xs">
                  Archived
                </Badge>
              )}
              <Badge variant="outline" className={statusColors[status] || ""}>
                {status}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>{apiaryName}</p>
          {installedDate && (
            <p>
              Installed: {new Date(installedDate).toLocaleDateString()}
            </p>
          )}
        </CardContent>
      </Card>
  );

  if (selecting) {
    return (
      <div
        onClick={() => onToggle?.(id)}
        className={isSelected ? "rounded-xl ring-2 ring-primary cursor-pointer" : "cursor-pointer"}
      >
        {body}
      </div>
    );
  }
  return <Link href={`/hives/${id}`}>{body}</Link>;
}
