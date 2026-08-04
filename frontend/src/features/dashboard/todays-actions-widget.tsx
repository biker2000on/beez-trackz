"use client";

import Link from "next/link";
import { ListChecks } from "lucide-react";

import { FieldItemRow } from "./field-item-row";
import { useFieldWork } from "./hooks";
import { WidgetFrame } from "./widget-frame";

const VISIBLE = 5;

/**
 * The visit checklist: work that is due but not yet escalated. Items already
 * shown under "Needs attention" never repeat here.
 */
export function TodaysActionsWidget() {
  const work = useFieldWork();
  const items = work.today;
  const shown = items.slice(0, VISIBLE);
  const extra = items.length - shown.length;

  return (
    <WidgetFrame
      title="Today's field actions"
      icon={ListChecks}
      isLoading={work.isPending}
      isError={work.isError}
    >
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing is due today.
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
