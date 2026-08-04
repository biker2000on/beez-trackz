"use client";

import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { FieldItemRow } from "./field-item-row";
import { useFieldWork } from "./hooks";
import { WidgetFrame } from "./widget-frame";

const VISIBLE = 5;

/** The first thing on the dashboard: what is actually wrong right now. */
export function NeedsAttentionWidget() {
  const work = useFieldWork();
  const items = work.attention;
  const shown = items.slice(0, VISIBLE);
  const extra = items.length - shown.length;

  return (
    <WidgetFrame
      title="Needs attention"
      icon={TriangleAlert}
      isLoading={work.isPending}
      isError={work.isError}
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
            <FieldItemRow key={item.id} item={item} />
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
