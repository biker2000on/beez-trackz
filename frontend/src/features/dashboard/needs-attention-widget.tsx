"use client";

import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { FieldItemRow } from "./field-item-row";
import { FIELD_VISIBLE, type FieldItem } from "./hooks";
import { WidgetFrame } from "./widget-frame";

/** The first thing on the dashboard: what is actually wrong right now. */
export function NeedsAttentionWidget({
  items,
  isPending,
  isError,
  focusedId,
}: {
  items: FieldItem[];
  isPending: boolean;
  isError: boolean;
  focusedId: string | null;
}) {
  const shown = items.slice(0, FIELD_VISIBLE);
  const extra = items.length - shown.length;

  return (
    <WidgetFrame
      title="Needs attention"
      icon={TriangleAlert}
      isLoading={isPending}
      isError={isError}
      action={
        items.length > 0 ? (
          <Badge variant="destructive">{items.length}</Badge>
        ) : null
      }
    >
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing needs attention. No unverified feeders and no urgent
          recommendations.
        </p>
      ) : (
        <ul className="grid gap-3">
          {shown.map((item) => (
            <FieldItemRow
              key={item.id}
              item={item}
              focused={item.id === focusedId}
            />
          ))}
          {extra > 0 && (
            <li>
              <Link
                href="/recommendations"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                +{extra} more
              </Link>
            </li>
          )}
        </ul>
      )}
    </WidgetFrame>
  );
}
