"use client";

import * as React from "react";
import { Info } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  describeSource,
  splitProvenance,
  type ProvenanceSource,
} from "@/lib/provenance";

/**
 * The quiet "Source" disclosure that import provenance folds into
 * (ui-coherence brief §6). Renders nothing when there are no sources, so a
 * note typed by the operator looks exactly as it did before.
 */
export function SourceNote({
  sources,
  className,
}: {
  sources: readonly ProvenanceSource[];
  className?: string;
}) {
  if (sources.length === 0) return null;
  const lines = sources.map(describeSource);
  return (
    <details
      className={cn(
        "group text-xs text-muted-foreground [&_summary::-webkit-details-marker]:hidden",
        className,
      )}
    >
      <summary
        className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={lines.join("\n")}
      >
        <Info aria-hidden className="size-3" />
        Source
      </summary>
      <ul className="mt-1 grid gap-0.5 pl-4">
        {lines.map((line, index) => (
          <li key={`${index}-${line}`}>{line}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * A note as the operator wrote it, with its import provenance behind
 * `SourceNote`. `as` picks the body element; the wrapper only appears when
 * there is a source to disclose. Renders nothing for a note that is only
 * provenance and `hideWhenEmpty` is set.
 */
export function NoteText({
  text,
  className,
  sourceClassName,
  as: Body = "p",
}: {
  text: string | null | undefined;
  /** Classes for the body element. */
  className?: string;
  /** Classes for the Source disclosure. */
  sourceClassName?: string;
  as?: "p" | "span" | "div";
}) {
  const { body, sources } = React.useMemo(() => splitProvenance(text), [text]);
  if (!body && sources.length === 0) return null;
  const note = body ? <Body className={className}>{body}</Body> : null;
  if (sources.length === 0) return note;
  return (
    <>
      {note}
      <SourceNote sources={sources} className={sourceClassName} />
    </>
  );
}
