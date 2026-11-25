"use client";

/**
 * The apiary Timeline tab: the yard's history as visit days, newest first.
 *
 * Answers "what did I do on Sep 13 across all hives?" (one day section),
 * "the oxalic series on B1, C3 and D1" (Find: `oxalic B1 C3 D1` plus the
 * Treatments chip) and "mite counts on Aug 13" (`?date=` or the Mite counts
 * chip). Everything that shapes the view is a search param, so any of those
 * answers is a link: the Ledger's end-of-visit summary opens
 * `?date=YYYY-MM-DD`, which scrolls to that day and outlines it.
 */

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CalendarSearch, LayoutGrid, List, RefreshCw, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useShortcut } from "@/components/shortcuts/provider";
import { apiaryRole, useAccessProfile } from "@/features/access/api";
import { parseCanvasLayout } from "@/features/canvas/lib/types";
import { FilterChips } from "@/features/hives/filter-chips";
import { useHives } from "@/features/hives/hooks";
import { ApiError } from "@/lib/api";
import { hiveDisplayLabel, type HiveLabelSource } from "@/lib/hive-label";
import { useSetSearchParams } from "@/lib/url-state";
import { cn } from "@/lib/utils";

import { ActivityDaySection } from "./activity-day";
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_LABELS,
  MAX_RANGE_DAYS,
  activityTypeOf,
  addDays,
  daysBetween,
  formatDay,
  isIsoDay,
  todayDay,
  type ActivityDay,
  type ActivityHive,
  type ActivityQuery,
  type ActivityType,
} from "./activity-types";
import { useApiary } from "./hooks";
import { useApiaryActivity } from "./use-apiary-activity";

/** Chip order: "All" plus the three a visit review needs first; the rest behind More. */
const CHIP_ORDER: readonly ActivityType[] = [
  "inspection",
  "treatment",
  "mite_count",
  "feeding",
  "status",
  "queen",
  "apiary_observation",
  "harvest",
  "split",
  "move",
];
const ALL = "all";

const HIVE_TOKEN = /^[a-z]{1,2}\d{1,2}$/i;

function parseTypes(raw: string | null): ActivityType[] {
  if (!raw) return [];
  const allowed = new Set<string>(ACTIVITY_TYPES);
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is ActivityType => allowed.has(value));
}

/**
 * Split Find into hive labels ("B1", "c3") and words ("oxalic"). Labels pick
 * hives; every word must appear in an event's title or notes.
 */
function parseFind(raw: string) {
  const tokens = raw.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return {
    hives: tokens.filter((token) => HIVE_TOKEN.test(token)),
    words: tokens.filter((token) => !HIVE_TOKEN.test(token)),
  };
}

/** Client-side mirror of the server's `types` filter, plus Find. */
function filterDays(
  days: readonly ActivityDay[],
  types: readonly ActivityType[],
  find: ReturnType<typeof parseFind>,
): ActivityDay[] {
  const typeOk = (type: ActivityType | null) =>
    types.length === 0 || (type != null && types.includes(type));
  const wordsOk = (text: string) =>
    find.words.every((word) => text.toLowerCase().includes(word));
  const out: ActivityDay[] = [];
  for (const day of days) {
    const notes =
      find.hives.length === 0 && typeOk("apiary_observation")
        ? day.apiaryObservations.filter((note) => wordsOk(note.notes ?? ""))
        : [];
    const hives: ActivityHive[] = [];
    for (const hive of day.hives) {
      if (
        find.hives.length > 0 &&
        !find.hives.includes(hive.positionLabel.toLowerCase())
      ) {
        continue;
      }
      const events = hive.events.filter(
        (event) =>
          typeOk(activityTypeOf(event)) &&
          wordsOk(`${event.title} ${event.details ?? ""}`),
      );
      if (events.length > 0) hives.push({ ...hive, events });
    }
    if (notes.length > 0 || hives.length > 0) {
      out.push({ ...day, apiaryObservations: notes, hives });
    }
  }
  return out;
}

function useReducedMotion(): boolean {
  return React.useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => true,
  );
}

function TimelineSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading the timeline">
      {[0, 1, 2].map((index) => (
        <div key={index} className="grid gap-3 rounded-xl border p-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-4/5" />
        </div>
      ))}
    </div>
  );
}

export function ApiaryTimeline({ apiaryId }: { apiaryId: string }) {
  const search = useSearchParams();
  const setParams = useSetSearchParams();
  const access = useAccessProfile();
  const canEdit = ["admin", "editor"].includes(
    apiaryRole(access.data, apiaryId) ?? "",
  );
  const apiary = useApiary(apiaryId);
  const roster = useHives({ apiaryId, includeArchived: true });
  const reducedMotion = useReducedMotion();

  // --- URL state -------------------------------------------------------
  const types = React.useMemo(() => parseTypes(search.get("types")), [search]);
  const view = search.get("view") === "grid" ? "grid" : "list";
  const rawDate = search.get("date");
  const date = isIsoDay(rawDate) ? rawDate : null;
  const rawFrom = search.get("from");
  const rawTo = search.get("to");
  const urlFrom = isIsoDay(rawFrom) ? rawFrom : undefined;
  const urlTo = isIsoDay(rawTo) ? rawTo : undefined;
  const urlFind = search.get("q") ?? "";

  // Find is typed locally and written to the URL after a pause.
  const [findDraft, setFindDraft] = React.useState(urlFind);
  React.useEffect(() => {
    if (findDraft.trim() === urlFind.trim()) return;
    const timer = window.setTimeout(
      () => setParams({ q: findDraft.trim() || null }),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [findDraft, urlFind, setParams]);
  const find = React.useMemo(() => parseFind(findDraft), [findDraft]);
  const hasRefine = Boolean(urlFind.trim() || urlFrom || urlTo);
  const [refineOpen, setRefineOpen] = React.useState(hasRefine);

  // A deep link to a day outside the default year asks for the season
  // around it instead.
  const today = todayDay();
  let from = urlFrom;
  let to = urlTo;
  if (date && !urlFrom && !urlTo && date < addDays(today, -365)) {
    from = addDays(date, -180);
    const end = addDays(date, 180);
    to = end > today ? today : end;
  }
  const rangeError =
    from && to && from > to
      ? "The start date is after the end date."
      : from && to && daysBetween(from, to) > MAX_RANGE_DAYS
        ? "Pick a range of three years or less."
        : null;

  const query: ActivityQuery = rangeError
    ? { types }
    : { from, to, types };
  const activity = useApiaryActivity(apiaryId, query);

  // --- labels ----------------------------------------------------------
  const labelSources = React.useMemo<HiveLabelSource[]>(() => {
    const byId = new Map<string, HiveLabelSource>();
    for (const hive of roster.data ?? []) byId.set(hive.id, hive);
    for (const day of activity.data?.days ?? []) {
      for (const hive of day.hives) {
        if (!byId.has(hive.hiveId)) {
          byId.set(hive.hiveId, {
            id: hive.hiveId,
            positionLabel: hive.positionLabel,
            status: hive.status,
            isArchived: hive.isArchived,
            installedDate: hive.installedDate,
            deadoutDate: hive.deadoutDate,
          });
        }
      }
    }
    return Array.from(byId.values());
  }, [roster.data, activity.data]);
  const labelFor = React.useCallback(
    (hive: ActivityHive) =>
      hiveDisplayLabel(
        {
          id: hive.hiveId,
          positionLabel: hive.positionLabel,
          status: hive.status,
          isArchived: hive.isArchived,
          installedDate: hive.installedDate,
          deadoutDate: hive.deadoutDate,
        },
        labelSources,
      ),
    [labelSources],
  );

  const stands = React.useMemo(
    () => parseCanvasLayout(apiary.data?.canvasLayout).stands,
    [apiary.data?.canvasLayout],
  );

  const days = React.useMemo(
    () => filterDays(activity.data?.days ?? [], types, find),
    [activity.data?.days, types, find],
  );
  const filtered = types.length > 0 || find.hives.length > 0 || find.words.length > 0;

  // --- ?date= deep link -------------------------------------------------
  // The target is the day itself, or the nearest earlier day when nothing
  // was recorded on it (days are newest first).
  const targetDay =
    !date || days.length === 0
      ? null
      : (days.find((day) => day.date <= date)?.date ?? days[days.length - 1].date);
  const exactHit = targetDay != null && targetDay === date;
  const targetHeading = React.useRef<HTMLHeadingElement | null>(null);
  const scrolledFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!date || !targetDay || scrolledFor.current === date) return;
    const heading = targetHeading.current;
    if (!heading) return;
    scrolledFor.current = date;
    heading
      .closest("section")
      ?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
    heading.focus({ preventScroll: true });
  }, [date, targetDay, reducedMotion]);

  // --- keyboard ---------------------------------------------------------
  const moveDay = React.useCallback((delta: 1 | -1) => {
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>("section[id^='day-']"),
    );
    if (sections.length === 0) return;
    const top = 96;
    const current = sections.findIndex(
      (section) => section.getBoundingClientRect().bottom > top + 1,
    );
    const next = sections[Math.min(Math.max((current < 0 ? 0 : current) + delta, 0), sections.length - 1)];
    next.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
    next.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }, [reducedMotion]);
  useShortcut("j", "Next (older) day", () => moveDay(1));
  useShortcut("k", "Previous (newer) day", () => moveDay(-1));
  useShortcut("v", "Switch list or grid", () =>
    setParams({ view: view === "grid" ? null : "grid" }),
  );

  // --- handlers ---------------------------------------------------------
  function toggleType(value: string) {
    if (value === ALL) {
      setParams({ types: null });
      return;
    }
    const type = value as ActivityType;
    const next = types.includes(type)
      ? types.filter((entry) => entry !== type)
      : [...types, type];
    setParams({ types: next.length > 0 ? next.join(",") : null });
  }
  function clearFilters() {
    setFindDraft("");
    setParams({ types: null, q: null });
  }
  const shownFrom = activity.data?.from ?? from ?? addDays(to ?? today, -365);
  const shownTo = activity.data?.to ?? to ?? today;
  function loadEarlier() {
    const nextFrom = addDays(shownFrom, -365);
    const nextTo =
      daysBetween(nextFrom, shownTo) > MAX_RANGE_DAYS
        ? addDays(nextFrom, MAX_RANGE_DAYS)
        : shownTo;
    setParams({ from: nextFrom, to: nextTo });
  }

  const chipOptions = [
    { value: ALL, label: "All" },
    ...CHIP_ORDER.map((type) => ({ value: type, label: ACTIVITY_TYPE_LABELS[type] })),
  ];

  // --- render -----------------------------------------------------------
  return (
    <div className="grid gap-4">
      <p className="max-w-prose text-sm text-muted-foreground">
        What was done on each visit, newest day first. Open a hive row to read
        its notes in full.
      </p>

      <div className="grid gap-3">
        <FilterChips
          label="Show only"
          options={chipOptions}
          active={types.length === 0 ? [ALL] : types}
          onSelect={toggleType}
          multiple
        />
        <div className="flex flex-wrap items-end gap-3">
          {/* On phones Find and the date range fold behind one button so
              the first screen shows history, not controls. */}
          <div
            id="timeline-refine"
            className={cn(
              "flex min-w-0 flex-1 basis-full flex-wrap items-end gap-3 sm:basis-auto",
              !refineOpen && "max-sm:hidden",
            )}
          >
            <div className="grid min-w-0 flex-1 basis-56 gap-1.5">
              <Label htmlFor="timeline-find">Find</Label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id="timeline-find"
                  type="search"
                  value={findDraft}
                  onChange={(event) => setFindDraft(event.target.value)}
                  placeholder="oxalic B1 C3"
                  className="pl-8"
                  aria-describedby="timeline-find-help"
                />
              </div>
              <p id="timeline-find-help" className="text-xs text-muted-foreground">
                Hive labels pick hives; other words must appear in the notes.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="timeline-from">From</Label>
              <Input
                id="timeline-from"
                type="date"
                value={from ?? ""}
                max={to ?? today}
                onChange={(event) => setParams({ from: event.target.value || null })}
                className="w-[10.5rem]"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="timeline-to">To</Label>
              <Input
                id="timeline-to"
                type="date"
                value={to ?? ""}
                min={from}
                max={today}
                onChange={(event) => setParams({ to: event.target.value || null })}
                className="w-[10.5rem]"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="touch:min-h-11 sm:hidden"
              aria-expanded={refineOpen}
              aria-controls="timeline-refine"
              onClick={() => setRefineOpen((open) => !open)}
            >
              <Search className="size-4" aria-hidden />
              {refineOpen ? "Hide find & dates" : hasRefine ? "Find & dates (on)" : "Find & dates"}
            </Button>
            <div
              className="inline-flex rounded-md border p-0.5"
              role="group"
              aria-label="Layout"
            >
              {(
                [
                  { value: "list", label: "List", icon: List },
                  { value: "grid", label: "Grid", icon: LayoutGrid },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={view === option.value}
                  onClick={() =>
                    setParams({ view: option.value === "grid" ? "grid" : null })
                  }
                  className={cn(
                    "inline-flex min-h-8 items-center gap-1.5 rounded px-3 text-sm font-medium transition-colors touch:min-h-10",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    view === option.value
                      ? "bg-primary/12 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <option.icon className="size-4" aria-hidden />
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {rangeError ? (
          <p role="alert" className="text-sm text-destructive">
            {rangeError} Showing the last year until it is fixed.
          </p>
        ) : null}
      </div>

      {date && activity.isSuccess && !exactHit ? (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
        >
          <CalendarSearch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            Nothing {filtered ? "matching these filters " : ""}was recorded on{" "}
            {formatDay(date)}.
            {targetDay ? ` Showing the nearest day, ${formatDay(targetDay)}.` : ""}
          </span>
        </p>
      ) : null}

      {activity.isPending ? (
        <TimelineSkeleton />
      ) : activity.isError ? (
        <div
          role="alert"
          className="grid justify-items-start gap-3 rounded-xl border border-dashed p-5"
        >
          <p className="text-sm font-medium">
            {activity.error instanceof ApiError && activity.error.status === 404
              ? "This server cannot list visit days yet."
              : activity.error instanceof ApiError && activity.error.status === 400
                ? "The server rejected this date range."
                : "Could not load the apiary timeline."}
          </p>
          <p className="max-w-prose text-sm text-muted-foreground">
            {activity.error instanceof ApiError && activity.error.status === 400
              ? "Pick a range of three years or less, then retry."
              : "Hive records are still on each hive’s own Timeline. Check your connection and retry."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void activity.refetch()}
              disabled={activity.isFetching}
            >
              <RefreshCw
                className={cn("size-4", activity.isFetching && "animate-spin motion-reduce:animate-none")}
                aria-hidden
              />
              {activity.isFetching ? "Retrying…" : "Retry"}
            </Button>
            {activity.error instanceof ApiError && activity.error.status === 400 ? (
              <Button
                variant="ghost"
                onClick={() => setParams({ from: null, to: null })}
              >
                Show the last year
              </Button>
            ) : null}
          </div>
        </div>
      ) : days.length === 0 ? (
        filtered ? (
          <div className="grid justify-items-start gap-3 rounded-xl border border-dashed p-5">
            <p className="text-sm font-medium">Nothing matches these filters.</p>
            <p className="text-sm text-muted-foreground">
              No records between {formatDay(shownFrom)} and {formatDay(shownTo)}
              {find.words.length > 0 ? ` mention “${find.words.join(" ")}”` : ""}
              {find.hives.length > 0
                ? ` on ${find.hives.map((hive) => hive.toUpperCase()).join(", ")}`
                : ""}
              {types.length > 0
                ? ` among ${types.map((type) => ACTIVITY_TYPE_LABELS[type].toLowerCase()).join(", ")}`
                : ""}
              .
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={clearFilters}>
                <X className="size-4" aria-hidden />
                Clear filters
              </Button>
              <Button variant="ghost" onClick={loadEarlier}>
                Search the year before
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid justify-items-start gap-3 rounded-xl border border-dashed p-5">
            <p className="text-sm font-medium">
              No visits recorded between {formatDay(shownFrom)} and{" "}
              {formatDay(shownTo)}.
            </p>
            <p className="max-w-prose text-sm text-muted-foreground">
              Each visit shows up here as one day, with a line per hive.
              {canEdit
                ? " Record visit covers the whole apiary in one pass; Bulk record logs the same work on many hives."
                : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {canEdit ? (
                // Record visit is the record header's primary action; the body does not repeat it.
                <Button asChild variant="outline">
                  <Link href={`/yard/apiaries/${apiaryId}/bulk`}>Bulk record</Link>
                </Button>
              ) : null}
              <Button variant="ghost" onClick={loadEarlier}>
                Show the year before
              </Button>
            </div>
          </div>
        )
      ) : (
        <>
          <div
            className={cn(
              "grid gap-4 transition-opacity motion-reduce:transition-none",
              activity.isFetching && !activity.isPending && "opacity-70",
            )}
          >
            {days.map((day) => (
              <ActivityDaySection
                key={day.date}
                day={day}
                view={view}
                stands={stands}
                labelFor={labelFor}
                highlighted={day.date === targetDay && date != null}
                headingRef={day.date === targetDay ? targetHeading : undefined}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm text-muted-foreground">
            <span>
              {formatDay(shownFrom)} – {formatDay(shownTo)}
            </span>
            <Button variant="outline" size="sm" onClick={loadEarlier}>
              Show the year before
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
