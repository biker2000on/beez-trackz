"use client";

/**
 * One visit day on the apiary Timeline: the apiary's own notes, then one row
 * per hive with a compact chip for each thing done. The grid view draws the
 * same day on the yard's stands (A1–D4) so "what happened at C3" is a glance.
 */

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  ChevronRight,
  Crown,
  Droplets,
  Flag,
  FlaskConical,
  MapPin,
  NotebookPen,
  Scissors,
  Sprout,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";

import { NoteText } from "@/components/record/source-note";
import { getSlotLabel, type StandGeometry } from "@/features/canvas/lib/types";
import { cn } from "@/lib/utils";

import {
  eventChip,
  eventTitle,
  formatDay,
  type ActivityDay,
  type ActivityEvent,
  type ActivityHive,
  type ActivityType,
} from "./activity-types";

export const ACTIVITY_ICONS: Record<ActivityType, LucideIcon> = {
  inspection: Stethoscope,
  feeding: Droplets,
  treatment: FlaskConical,
  mite_count: Activity,
  queen: Crown,
  split: Scissors,
  harvest: Sprout,
  move: MapPin,
  status: Flag,
  apiary_observation: NotebookPen,
};

const timeOfDay = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function observedTime(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : timeOfDay.format(date);
}

function isRetired(hive: Pick<ActivityHive, "status" | "isArchived">): boolean {
  return hive.isArchived || hive.status !== "active";
}

/** A compact, single-line event chip: icon, lead word, one-liner. */
export function EventChipView({ event }: { event: ActivityEvent }) {
  const chip = eventChip(event);
  const Icon = chip.type ? ACTIVITY_ICONS[chip.type] : Activity;
  const alarming = chip.type === "status";
  return (
    <span
      className={cn(
        "inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border bg-background px-2 text-xs",
        alarming && "border-destructive/40 text-destructive",
      )}
    >
      <Icon
        className={cn("size-3.5 shrink-0", alarming ? "text-destructive" : "text-primary")}
        aria-hidden
      />
      <span className="shrink-0 font-medium">{chip.lead}</span>
      {chip.text ? (
        <span className={cn("truncate", !alarming && "text-muted-foreground")}>
          {chip.type === "mite_count" ? (
            <span className="tabular-nums">{chip.text}</span>
          ) : (
            chip.text
          )}
        </span>
      ) : null}
    </span>
  );
}

/** The expanded body of a hive row: every event in full, plus its photos. */
export function HiveEventDetails({
  hive,
  label,
}: {
  hive: ActivityHive;
  label: string;
}) {
  return (
    <div className="grid gap-3">
      <ul className="grid gap-3">
        {hive.events.map((event) => {
          const chip = eventChip(event);
          const Icon = chip.type ? ACTIVITY_ICONS[chip.type] : Activity;
          const photos = event.photos ?? [];
          return (
            <li key={`${event.type}-${event.id}`} className="grid gap-1.5">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Icon className="size-4 shrink-0 text-primary" aria-hidden />
                {eventTitle(event)}
                {chip.type === "mite_count" ? (
                  <span className="font-normal tabular-nums text-muted-foreground">
                    {chip.text}
                  </span>
                ) : null}
              </p>
              {event.details ? (
                <NoteText
                  text={event.details}
                  className="max-w-prose whitespace-pre-wrap pl-6 text-sm text-muted-foreground"
                  sourceClassName="pl-6"
                />
              ) : null}
              {photos.length > 0 ? (
                <div className="grid grid-cols-3 gap-2 pl-6 sm:grid-cols-4">
                  {photos.map((photo) => (
                    // Same-origin authenticated media, as on the hive timeline.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={photo.id}
                      src={photo.url}
                      alt={photo.caption ?? `${eventTitle(event)} photo, ${label}`}
                      className="aspect-[4/3] w-full rounded-md border object-cover"
                      loading="lazy"
                    />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Link
        href={`/yard/hives/${hive.hiveId}/timeline`}
        className="inline-flex min-h-9 w-fit items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline touch:min-h-11"
      >
        Open {label}
        <ChevronRight className="size-4" aria-hidden />
      </Link>
    </div>
  );
}

/** One hive on one day: label and chips; tap to read everything in full. */
function HiveRow({ hive, label }: { hive: ActivityHive; label: string }) {
  const retired = isRetired(hive);
  return (
    <li>
      <details className="group rounded-lg border bg-card open:bg-muted/30">
        <summary className="flex min-h-11 cursor-pointer list-none items-start gap-3 rounded-lg px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span
            className={cn(
              "min-w-14 shrink-0 pt-1 text-sm font-semibold tabular-nums",
              retired && "text-muted-foreground",
            )}
          >
            {label}
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap gap-1.5 py-0.5">
            {hive.events.map((event) => (
              <EventChipView key={`${event.type}-${event.id}`} event={event} />
            ))}
          </span>
          <ChevronRight
            className="mt-1.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
        </summary>
        <div className="border-t px-3 py-3">
          <HiveEventDetails hive={hive} label={label} />
        </div>
      </details>
    </li>
  );
}

function ApiaryNotes({ day }: { day: ActivityDay }) {
  if (day.apiaryObservations.length === 0) return null;
  return (
    <div className="grid gap-2 rounded-lg bg-muted/40 px-3 py-2.5">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <NotebookPen className="size-3.5" aria-hidden />
        Apiary
      </h3>
      <ul className="grid gap-2">
        {day.apiaryObservations.map((note) => {
          const time = observedTime(note.observedAt);
          return (
            <li key={note.id} className="grid gap-0.5">
              {time ? (
                <span className="text-xs tabular-nums text-muted-foreground">{time}</span>
              ) : null}
              <NoteText
                text={note.notes}
                className="max-w-prose whitespace-pre-wrap text-sm"
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- grid ---------------------------------------------------------------

interface GridRow {
  key: string;
  label: string;
  cols: number;
  cells: { key: string; label: string; hives: ActivityHive[] }[];
}

const LABEL_RE = /^([A-Za-z]+)\s*(\d+)$/;

/**
 * Lay the day's hives on the yard's stands. A hive lands in a slot by its
 * stand coordinates, else by matching the slot's label (retired hives often
 * lost their slot when they left the stand). Without a drawn layout the grid
 * is derived from the labels themselves: one row per letter, A1–D4.
 */
export function buildDayGrid(
  stands: readonly StandGeometry[],
  hives: readonly ActivityHive[],
): { rows: GridRow[]; unplaced: ActivityHive[] } {
  const placed = new Set<string>();
  const rows: GridRow[] = [];

  if (stands.length > 0) {
    const ordered = [...stands].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true }),
    );
    for (const stand of ordered) {
      const cells: GridRow["cells"] = [];
      for (let row = 0; row < stand.rows; row += 1) {
        for (let col = 0; col < stand.cols; col += 1) {
          const label = getSlotLabel(stand.label, row, col, stand.cols);
          const here = hives.filter(
            (hive) =>
              !placed.has(hive.hiveId) &&
              ((hive.standId === stand.id && hive.slotRow === row && hive.slotCol === col) ||
                hive.positionLabel.toUpperCase() === label.toUpperCase()),
          );
          here.forEach((hive) => placed.add(hive.hiveId));
          cells.push({ key: `${stand.id}-${row}-${col}`, label, hives: here });
        }
      }
      rows.push({ key: stand.id, label: stand.label, cols: stand.cols, cells });
    }
  } else {
    const byLetter = new Map<string, Map<number, ActivityHive[]>>();
    for (const hive of hives) {
      const match = LABEL_RE.exec(hive.positionLabel.trim());
      if (!match) continue;
      const letter = match[1].toUpperCase();
      const slot = Number(match[2]);
      const slots = byLetter.get(letter) ?? new Map<number, ActivityHive[]>();
      slots.set(slot, [...(slots.get(slot) ?? []), hive]);
      byLetter.set(letter, slots);
      placed.add(hive.hiveId);
    }
    const width = Math.max(
      4,
      ...Array.from(byLetter.values()).flatMap((slots) => Array.from(slots.keys())),
    );
    for (const letter of Array.from(byLetter.keys()).sort()) {
      const slots = byLetter.get(letter)!;
      rows.push({
        key: letter,
        label: letter,
        cols: width,
        cells: Array.from({ length: width }, (_, index) => ({
          key: `${letter}${index + 1}`,
          label: `${letter}${index + 1}`,
          hives: slots.get(index + 1) ?? [],
        })),
      });
    }
  }

  return { rows, unplaced: hives.filter((hive) => !placed.has(hive.hiveId)) };
}

function GridCell({
  label,
  hives,
  selectedId,
  onSelect,
}: {
  label: string;
  hives: ActivityHive[];
  selectedId: string | null;
  onSelect: (hiveId: string) => void;
}) {
  if (hives.length === 0) {
    return (
      <div className="grid min-h-14 place-items-center rounded-md border border-dashed text-xs text-muted-foreground/70">
        <span>
          {label}
          <span className="sr-only">: nothing recorded</span>
        </span>
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      {hives.map((hive) => {
        const types = Array.from(
          new Set(hive.events.map((event) => eventChip(event).type)),
        ).filter((type): type is ActivityType => type != null);
        const selected = selectedId === hive.hiveId;
        return (
          <button
            key={hive.hiveId}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(hive.hiveId)}
            className={cn(
              "grid min-h-14 content-center justify-items-center gap-1 rounded-md border bg-card px-1 py-1.5 text-xs font-semibold transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "border-primary bg-primary/12 text-primary" : "hover:border-primary/50",
              isRetired(hive) && !selected && "text-muted-foreground",
            )}
          >
            <span>{hive.positionLabel}</span>
            <span className="flex flex-wrap justify-center gap-0.5" aria-hidden>
              {types.slice(0, 4).map((type) => {
                const Icon = ACTIVITY_ICONS[type];
                return <Icon key={type} className="size-3.5 text-primary" />;
              })}
            </span>
            <span className="sr-only">
              : {hive.events.map((event) => eventChip(event).lead).join(", ")}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function DayGrid({
  day,
  stands,
  labelFor,
}: {
  day: ActivityDay;
  stands: readonly StandGeometry[];
  labelFor: (hive: ActivityHive) => string;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const { rows, unplaced } = React.useMemo(
    () => buildDayGrid(stands, day.hives),
    [stands, day.hives],
  );
  const selected = day.hives.find((hive) => hive.hiveId === selectedId) ?? null;
  const toggle = (hiveId: string) =>
    setSelectedId((current) => (current === hiveId ? null : hiveId));

  return (
    <div className="grid gap-3">
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="grid w-max min-w-full gap-2">
          {rows.map((row) => (
            <div key={row.key} className="flex items-start gap-2">
              <span className="w-6 shrink-0 pt-4 text-center text-xs font-semibold text-muted-foreground">
                {row.label}
              </span>
              <div
                className="grid flex-1 gap-1.5"
                style={{ gridTemplateColumns: `repeat(${row.cols}, minmax(3.5rem, 1fr))` }}
              >
                {row.cells.map((cell) => (
                  <GridCell
                    key={cell.key}
                    label={cell.label}
                    hives={cell.hives}
                    selectedId={selectedId}
                    onSelect={toggle}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {unplaced.length > 0 ? (
        <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">Not on a stand</p>
          <div className="flex flex-wrap gap-1.5">
            {unplaced.map((hive) => (
              <div key={hive.hiveId} className="w-20">
                <GridCell
                  label={hive.positionLabel}
                  hives={[hive]}
                  selectedId={selectedId}
                  onSelect={toggle}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {selected ? (
        <div className="rounded-lg border bg-card px-3 py-3">
          <h3 className="mb-2 text-sm font-semibold">{labelFor(selected)}</h3>
          <HiveEventDetails hive={selected} label={labelFor(selected)} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Tap a hive to read what was done.
        </p>
      )}
    </div>
  );
}

// --- day ----------------------------------------------------------------

export function ActivityDaySection({
  day,
  view,
  stands,
  labelFor,
  highlighted,
  headingRef,
}: {
  day: ActivityDay;
  view: "list" | "grid";
  stands: readonly StandGeometry[];
  labelFor: (hive: ActivityHive) => string;
  /** The `?date=` target: outlined and announced as the current date. */
  highlighted: boolean;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const hiveCount = day.hives.length;
  const noteCount = day.apiaryObservations.length;
  const summary = [
    hiveCount > 0 ? `${hiveCount} ${hiveCount === 1 ? "hive" : "hives"}` : null,
    noteCount > 0 ? `${noteCount} apiary ${noteCount === 1 ? "note" : "notes"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const headingId = `day-${day.date}-heading`;

  return (
    <section
      id={`day-${day.date}`}
      aria-labelledby={headingId}
      aria-current={highlighted ? "date" : undefined}
      className={cn(
        "grid scroll-mt-24 gap-3 rounded-xl border p-3 sm:p-4",
        highlighted ? "border-primary bg-primary/5 ring-1 ring-primary" : "bg-card/40",
      )}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-base font-semibold outline-none"
        >
          {formatDay(day.date)}
        </h2>
        <p className="text-xs text-muted-foreground">{summary}</p>
      </header>
      <ApiaryNotes day={day} />
      {hiveCount > 0 ? (
        view === "grid" ? (
          <DayGrid day={day} stands={stands} labelFor={labelFor} />
        ) : (
          <ul className="grid gap-1.5">
            {day.hives.map((hive) => (
              <HiveRow key={hive.hiveId} hive={hive} label={labelFor(hive)} />
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
