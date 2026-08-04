"use client";

import Link from "next/link";
import { ListChecks } from "lucide-react";

import { FieldItemRow } from "./field-item-row";
import { FIELD_VISIBLE, type FieldItem } from "./hooks";
import { WidgetFrame } from "./widget-frame";

/**
 * The visit checklist: work that is due but not yet escalated. Items already
 * shown under "Needs attention" never repeat here.
 */
export function TodaysActionsWidget({
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
      title="Today's field actions"
      icon={ListChecks}
      isLoading={isPending}
      isError={isError}
    >
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing is due today.
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
