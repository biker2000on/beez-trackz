"use client";

import * as React from "react";
import Link from "next/link";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  PackagePlus,
  Pencil,
  Plus,
  QrCode,
  ScanSearch,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatLbs } from "@/features/honey/format";
import {
  useApiaryOptions,
  useHarvests,
  useHoneyVarietals,
  useJarInventory,
} from "@/features/honey/hooks";
import { ApiError } from "@/lib/api";
import {
  METERS_PER_FOOT,
  parseElevation,
  parseHoneyMassInput,
  parseMass,
  preferredElevationSuffix,
  type UnitsSystem,
} from "@/lib/units";
import { useUnits } from "@/lib/use-units";
import { todayISO } from "@/features/honey/format";
import {
  draftLotStory,
  fetchLotPrefill,
  useCreateBottlingRun,
  useCreateHarvestLot,
  useHarvestLots,
  useUpdateHarvestLot,
  type HarvestLot,
  type LotPrefill,
  type LotStoryDraft,
} from "./api";

function honeyStoryHref(slug: string) {
  return `/honey/${slug}`;
}

export function LotsTab() {
  const lots = useHarvestLots();
  const harvests = useHarvests();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editLot, setEditLot] = React.useState<HarvestLot | null>(null);
  const [bottleLot, setBottleLot] = React.useState<HarvestLot | null>(null);

  if (lots.isPending || harvests.isPending) return <Skeleton className="h-64 w-full" />;
  if (lots.isError || harvests.isError) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Could not load harvest lots.</p>;
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href="/production/serials">
            <ScanSearch />
            Serial lookup
          </Link>
        </Button>
        <Button size="sm" onClick={() => setCreateOpen(true)}><Plus /> New harvest lot</Button>
      </div>
      {lots.data.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
          No harvest lots yet. Create one to connect extraction, bottles, QR labels, and the public Honey Story.
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {lots.data.map((lot) => (
            <Card key={lot.id}>
              <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
                <div>
                  <CardTitle className="text-base">{lot.lotCode}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(lot.extractionDate)} · {formatLbs(lot.honeyWeightLbs)}
                    {lot.honeyWeightSource === "derived"
                      ? ` · derived from ${lot.linkedHarvestCount} ${
                          lot.linkedHarvestCount === 1 ? "harvest" : "harvests"
                        }`
                      : lot.linkedHarvestCount > 0 &&
                          lot.derivedWeightLbs !== lot.honeyWeightLbs
                        ? ` · typed; ${lot.linkedHarvestCount} ${
                            lot.linkedHarvestCount === 1 ? "harvest sums" : "harvests sum"
                          } to ${formatLbs(lot.derivedWeightLbs)}`
                        : ""}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  <Badge variant={lot.isPublic ? "accent" : "outline"}>{lot.isPublic ? "Public story" : "Private"}</Badge>
                  {lot.lockout?.locked && <Badge variant="destructive">Locked</Badge>}
                </div>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid grid-cols-[88px_1fr] gap-3">
                  {/* Same-origin endpoint; QR content points at the curated public page. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/v1/harvest-lots/${lot.id}/qr`} alt={`QR code for ${lot.lotCode}`} className="size-[88px] rounded-md border bg-white p-1" />
                  <div className="grid content-start gap-1 text-sm">
                    <p className="font-medium">{lot.floralClaim || (lot.varietalName ?? "No varietal assigned")}{lot.season ? ` · ${lot.season}` : ""}</p>
                    <p className="text-xs text-muted-foreground">
                      {lot.apiaryRegion ?? (lot.sourceApiaries.join(", ") || "Region not published")}
                    </p>
                    {(lot.moisturePct != null || lot.bottlingMoisturePct != null) && (
                      <p className="text-xs text-muted-foreground">
                        {lot.moisturePct != null ? `Extracted ${lot.moisturePct}%` : "Extraction moisture not recorded"}
                        {lot.bottlingMoisturePct != null ? ` · Bottled ${lot.bottlingMoisturePct}%` : ""}
                        {lot.moistureOverrideReason ? ` · Override: ${lot.moistureOverrideReason}` : ""}
                      </p>
                    )}
                    {lot.lockout?.locked && (
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                        {lot.lockout.message}
                      </p>
                    )}
                    <Link href={honeyStoryHref(lot.publicSlug)} target="_blank" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                      Open Honey Story <ExternalLink className="size-3" />
                    </Link>
                  </div>
                </div>
                {lot.bottlingRuns.length > 0 && (
                  <div className="grid gap-1 rounded-md bg-muted p-3 text-xs">
                    {lot.bottlingRuns.map((run) => (
                      <div key={run.id} className="flex justify-between gap-2">
                        <span>{formatDate(run.bottledDate)} · {run.jarSizeLabel ?? "Bulk"}</span>
                        <span className="font-medium">{run.quantity} jars{run.serialCount > 0 ? ` · ${run.serialCount} serialized` : ""}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setBottleLot(lot)}>
                    <PackagePlus /> Add bottling run
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditLot(lot)}>
                    <Pencil /> Edit lot
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {createOpen && (
        <LotFormDialog open onOpenChange={setCreateOpen} harvests={harvests.data} />
      )}
      {editLot && (
        <LotFormDialog
          open
          onOpenChange={(open) => !open && setEditLot(null)}
          harvests={harvests.data}
          lot={editLot}
        />
      )}
      {bottleLot && <BottlingDialog lot={bottleLot} open onOpenChange={(open) => !open && setBottleLot(null)} />}
    </div>
  );
}

/** Fields the yard prefill may write. Each one stops auto-filling once typed in. */
type AutoField = "season" | "region" | "elevation" | "year" | "bloom" | "varietal";

/** The elevation the way the operator types it, so the auto value reads like their own. */
function elevationInput(meters: number, units: UnitsSystem): string {
  return units === "us"
    ? `${Math.round(meters / METERS_PER_FOOT)} ft`
    : `${Math.round(meters)} m`;
}

function AutoHint({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span
      data-testid="auto-hint"
      className="rounded-sm bg-muted px-1 text-[10px] font-normal uppercase tracking-wide text-muted-foreground"
    >
      auto
    </span>
  );
}

/** Create a lot, or — when `lot` is set — edit it in place (same fields). */
function LotFormDialog({
  open,
  onOpenChange,
  harvests,
  lot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  harvests: ReturnType<typeof useHarvests>["data"];
  lot?: HarvestLot;
}) {
  const create = useCreateHarvestLot();
  const update = useUpdateHarvestLot();
  const busy = create.isPending || update.isPending;
  const [lotCode, setLotCode] = React.useState(
    () =>
      lot?.lotCode ??
      `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`,
  );
  const [date, setDate] = React.useState(
    () => lot?.extractionDate?.slice(0, 10) ?? todayISO(),
  );
  // The day the supers came off. With the yard and the extraction date it
  // bounds the window the prefill reads the season's notes from.
  const [pulledOn, setPulledOn] = React.useState(
    () => lot?.pulledOn?.slice(0, 10) ?? "",
  );
  // Seed from the typed text only when it names its unit. A bare number
  // stored by one preference must not be re-parsed under another — that
  // would silently rewrite honey_weight_lbs (the bottling ceiling).
  const [weight, setWeight] = React.useState(() => {
    if (!lot) return "";
    const entered = lot.honeyWeightEntered?.trim();
    if (entered && parseMass(entered, "pounds")?.suffix) return entered;
    return `${lot.honeyWeightLbs} lb`;
  });
  // A derived lot takes its weight from the harvests below and recomputes
  // whenever that set changes. A new lot starts derived so the default is the
  // number the scale actually produced; typing a weight is the override.
  const [weightSource, setWeightSource] = React.useState<"manual" | "derived">(
    () => lot?.honeyWeightSource ?? "derived",
  );
  // The varietal is the honey's name: it titles the public Honey Story and
  // groups the balance rollups. There is no free-text name beside it. The
  // claim species is derived from it server-side, so it is not asked twice.
  const [varietalId, setVarietalId] = React.useState(lot?.varietalId ?? "");
  const varietals = useHoneyVarietals();
  const [claimYear, setClaimYear] = React.useState(
    lot?.claimYear != null ? String(lot.claimYear) : "",
  );
  const [claimApiaryId, setClaimApiaryId] = React.useState(
    lot?.claimApiaryId ?? "",
  );
  const [claimElevation, setClaimElevation] = React.useState(
    lot?.claimElevationM != null ? `${Math.round(lot.claimElevationM)} m` : "",
  );
  const apiaries = useApiaryOptions();
  const units = useUnits();
  const [season, setSeason] = React.useState(lot?.season ?? "");
  const [region, setRegion] = React.useState(lot?.apiaryRegion ?? "");
  const [bloom, setBloom] = React.useState(lot?.bloomNotes ?? "");
  const [story, setStory] = React.useState(lot?.beekeeperStory ?? "");
  const [reorder, setReorder] = React.useState(lot?.reorderUrl ?? "");
  // Two selections: what the operator ticked, and what the prefill suggested.
  // A later prefill may replace its own suggestions but never the operator's.
  const [userHarvestIds, setUserHarvestIds] = React.useState<string[]>(
    () => lot?.sourceHarvestIds ?? [],
  );
  const [autoHarvestIds, setAutoHarvestIds] = React.useState<string[]>([]);
  const [showAllHarvests, setShowAllHarvests] = React.useState(false);
  const [photoIds, setPhotoIds] = React.useState(
    () => lot?.photos.map((photo) => photo.id).join(", ") ?? "",
  );
  const [moisture, setMoisture] = React.useState(
    () => (lot?.moisturePct != null ? String(lot.moisturePct) : ""),
  );
  const [bottlingMoisture, setBottlingMoisture] = React.useState(
    () => (lot?.bottlingMoisturePct != null ? String(lot.bottlingMoisturePct) : ""),
  );
  // Revealed only after the server rejects an over-threshold reading, so the
  // default path stays a hard reject. A lot that already carries an override
  // starts accepted, so an unrelated edit re-submits (and preserves) it
  // instead of tripping the reject again.
  const [overrideOffered, setOverrideOffered] = React.useState(
    () => lot?.moistureOverrideReason != null,
  );
  const [overrideAccepted, setOverrideAccepted] = React.useState(
    () => lot?.moistureOverrideReason != null,
  );
  const [overrideReason, setOverrideReason] = React.useState(
    () => lot?.moistureOverrideReason ?? "",
  );
  const [moistureError, setMoistureError] = React.useState<string | null>(null);

  // --- Prefill from the yard --------------------------------------------
  // A field the operator has typed in is theirs; the prefill only writes the
  // others, and marks what it wrote so the "auto" hint can say so until the
  // operator edits it.
  const [touched, setTouched] = React.useState<ReadonlySet<AutoField>>(
    () => new Set(),
  );
  const [autoFilled, setAutoFilled] = React.useState<ReadonlySet<AutoField>>(
    () => new Set(),
  );
  const [prefill, setPrefill] = React.useState<LotPrefill | null>(null);
  const touch = React.useCallback((field: AutoField) => {
    setTouched((current) => new Set(current).add(field));
    setAutoFilled((current) => {
      if (!current.has(field)) return current;
      const next = new Set(current);
      next.delete(field);
      return next;
    });
  }, []);
  // The prefill effect reads these when its response lands, without
  // re-running (and re-fetching) every time one of them changes.
  const latest = React.useRef({ touched, autoFilled, varietalId, units: units.units });
  React.useEffect(() => {
    latest.current = { touched, autoFilled, varietalId, units: units.units };
  }, [touched, autoFilled, varietalId, units.units]);

  const prefillKey =
    claimApiaryId && pulledOn && date ? `${claimApiaryId}|${pulledOn}|${date}` : "";
  // An existing lot is not re-read on open: its fields are what was saved.
  // Only a change of yard or dates after opening asks the yard again.
  const lastPrefillKey = React.useRef(lot ? prefillKey : "");

  React.useEffect(() => {
    if (!prefillKey || prefillKey === lastPrefillKey.current) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      lastPrefillKey.current = prefillKey;
      fetchLotPrefill(
        { apiaryId: claimApiaryId, pulledOn, extractedOn: date },
        controller.signal,
      )
        .then((data) => {
          if (controller.signal.aborted) return;
          const { touched, autoFilled, varietalId, units } = latest.current;
          const nextAuto = new Set(autoFilled);
          const write = (
            field: AutoField,
            value: string | null,
            set: (value: string) => void,
          ) => {
            if (touched.has(field)) return;
            if (value) {
              set(value);
              nextAuto.add(field);
            } else if (autoFilled.has(field)) {
              // The previous yard's value does not belong to this one.
              set("");
              nextAuto.delete(field);
            }
          };
          write("season", data.season, setSeason);
          write("region", data.apiaryRegion, setRegion);
          write(
            "elevation",
            data.elevationM != null ? elevationInput(data.elevationM, units) : null,
            setClaimElevation,
          );
          write(
            "year",
            data.claimYear != null ? String(data.claimYear) : null,
            setClaimYear,
          );
          write("bloom", data.bloomNotes, setBloom);
          if (
            !touched.has("varietal") &&
            data.suggestedVarietalId &&
            (!varietalId || autoFilled.has("varietal"))
          ) {
            setVarietalId(data.suggestedVarietalId);
            nextAuto.add("varietal");
          }
          setAutoFilled(nextAuto);
          setAutoHarvestIds(
            data.harvests
              .filter(
                (harvest) =>
                  harvest.suggested &&
                  (harvest.inLotId == null || harvest.inLotId === lot?.id),
              )
              .map((harvest) => harvest.id),
          );
          setPrefill(data);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          toast.error(
            cause instanceof Error && cause.message
              ? `Could not read the yard's notes: ${cause.message}`
              : "Could not read the yard's notes",
          );
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [prefillKey, claimApiaryId, pulledOn, date, lot?.id]);

  // --- Source harvests ---------------------------------------------------
  const harvestIds = React.useMemo(
    () => Array.from(new Set([...userHarvestIds, ...autoHarvestIds])),
    [userHarvestIds, autoHarvestIds],
  );
  const prefillHarvests = React.useMemo(
    () => new Map((prefill?.harvests ?? []).map((harvest) => [harvest.id, harvest])),
    [prefill],
  );
  const harvestRows = React.useMemo(
    () =>
      (harvests ?? []).map((harvest) => {
        const known = prefillHarvests.get(harvest.id);
        const inLotId = known?.inLotId ?? null;
        return {
          ...harvest,
          suggested: known?.suggested ?? false,
          // The lot's own harvests are not "in another lot".
          claimed: inLotId != null && inLotId !== lot?.id,
        };
      }),
    [harvests, prefillHarvests, lot?.id],
  );
  const featuredRows = harvestRows.filter(
    (row) => row.suggested || harvestIds.includes(row.id),
  );
  const visibleRows = showAllHarvests
    ? [...featuredRows, ...harvestRows.filter((row) => !featuredRows.includes(row))]
    : featuredRows;
  const hiddenCount = harvestRows.length - featuredRows.length;
  const apiaryNames = Array.from(new Set(visibleRows.map((row) => row.apiaryName)));
  const groupedRows =
    apiaryNames.length > 1
      ? apiaryNames.map((name) => ({
          name,
          rows: visibleRows.filter((row) => row.apiaryName === name),
        }))
      : [{ name: null, rows: visibleRows }];

  function toggleHarvest(id: string, checked: boolean) {
    if (checked) {
      setUserHarvestIds((current) => (current.includes(id) ? current : [...current, id]));
    } else {
      setUserHarvestIds((current) => current.filter((item) => item !== id));
      setAutoHarvestIds((current) => current.filter((item) => item !== id));
    }
  }

  // Previewed client-side from the ticked harvests so the number moves with
  // the checkboxes; the server recomputes the same SUM on save.
  const selectedHarvests = (harvests ?? []).filter((harvest) =>
    harvestIds.includes(harvest.id),
  );
  const derivedLbs = selectedHarvests.reduce(
    (total, harvest) => total + harvest.calculatedHoneyWeight,
    0,
  );
  // Nothing to derive from yet, so the field has to stay typed.
  const derivable = selectedHarvests.length > 0;
  const useDerived = weightSource === "derived" && derivable;

  // --- Beekeeper story ---------------------------------------------------
  const [drafting, setDrafting] = React.useState(false);
  const [draftSources, setDraftSources] = React.useState<
    LotStoryDraft["sources"] | null
  >(null);
  const canDraft = Boolean(claimApiaryId && pulledOn && date);

  async function draftStory() {
    if (!canDraft || drafting) return;
    if (
      story.trim() &&
      !window.confirm("Replace the current beekeeper story with an AI draft?")
    ) {
      return;
    }
    setDrafting(true);
    try {
      const draft = await draftLotStory({
        apiaryId: claimApiaryId,
        pulledOn,
        extractedOn: date,
        varietalId: varietalId || undefined,
        harvestIds: harvestIds.length > 0 ? harvestIds : undefined,
      });
      setStory(draft.story);
      setDraftSources(draft.sources);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 503) {
        toast.error(
          "No AI provider is configured. Add one under Admin, then draft again.",
        );
      } else {
        toast.error(
          cause instanceof Error && cause.message
            ? `Could not draft the story: ${cause.message}`
            : "Could not draft the story",
        );
      }
    } finally {
      setDrafting(false);
    }
  }

  function resetDraft() {
    setLotCode("");
    setDate(todayISO());
    setPulledOn("");
    setWeight("");
    setWeightSource("derived");
    setVarietalId("");
    setClaimYear("");
    setClaimApiaryId("");
    setClaimElevation("");
    setSeason("");
    setRegion("");
    setBloom("");
    setStory("");
    setReorder("");
    setUserHarvestIds([]);
    setAutoHarvestIds([]);
    setShowAllHarvests(false);
    setPhotoIds("");
    setMoisture("");
    setBottlingMoisture("");
    setOverrideOffered(false);
    setOverrideAccepted(false);
    setOverrideReason("");
    setMoistureError(null);
    setTouched(new Set());
    setAutoFilled(new Set());
    setPrefill(null);
    setDraftSources(null);
    lastPrefillKey.current = "";
  }

  function submit(resetAfter = false) {
    const pounds = parseHoneyMassInput(weight, units.units);
    if (!lotCode.trim() || !date) return;
    if (!useDerived && (pounds == null || pounds < 0)) return;
    const claimYearNumber = claimYear.trim() ? Number(claimYear) : undefined;
    if (claimYearNumber !== undefined && !Number.isInteger(claimYearNumber)) return;
    const elevation = parseElevation(claimElevation, units.units);
    const payload = {
      lotCode: lotCode.trim(),
      extractionDate: date,
      pulledOn: pulledOn || null,
      // A derived lot sends no weight at all: the server owns the number, and
      // shipping a stale client-side sum would defeat the point.
      honeyWeightSource: useDerived ? ("derived" as const) : ("manual" as const),
      honeyWeightLbs: useDerived ? undefined : (pounds ?? 0),
      // Persist the typed text with an explicit unit so a later edit under a
      // different preference cannot re-interpret it.
      honeyWeightEntered:
        !useDerived && weight.trim()
          ? parseMass(weight, "pounds")?.suffix
            ? weight.trim()
            : `${weight.trim()} ${units.units === "metric" ? "kg" : "lb"}`
          : undefined,
      claimYear: claimYearNumber,
      claimApiaryId: claimApiaryId || undefined,
      claimElevationM: elevation?.meters,
      varietalId: varietalId || null,
      season: season.trim() || undefined,
      apiaryRegion: region.trim() || undefined,
      bloomNotes: bloom.trim() || undefined,
      beekeeperStory: story.trim() || undefined,
      reorderUrl: reorder.trim() || undefined,
      isPublic: lot?.isPublic ?? true,
      harvestIds,
      photoIds: photoIds.split(",").map((id) => id.trim()).filter(Boolean),
      moisturePct: moisture.trim() ? Number(moisture) : null,
      bottlingMoisturePct: bottlingMoisture.trim() ? Number(bottlingMoisture) : null,
      moistureOverride: overrideAccepted || undefined,
      moistureOverrideReason:
        overrideAccepted && overrideReason.trim() ? overrideReason.trim() : undefined,
    };
    setMoistureError(null);
    const onError = (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : "";
      // Only the over-threshold rejection is overridable; range and
      // reason-length errors would fail the resubmit identically.
      if (/is over the .* harvest threshold/i.test(message) ||
          /Set moistureOverrideReason/i.test(message)) {
        setMoistureError(message);
        setOverrideOffered(true);
      } else if (/moisture/i.test(message)) {
        setMoistureError(message);
      }
    };
    if (lot) {
      // Keep the published slug stable so printed QR labels keep resolving.
      update.mutate(
        { id: lot.id, publicSlug: lot.publicSlug, ...payload },
        { onSuccess: () => onOpenChange(false), onError },
      );
    } else {
      create.mutate(payload, {
        onSuccess: () => {
          if (resetAfter) resetDraft();
          else onOpenChange(false);
        },
        onError,
      });
    }
  }

  const labelClass = "flex items-center gap-1.5";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{lot ? `Edit lot ${lot.lotCode}` : "Create harvest lot"}</DialogTitle></DialogHeader>
        <ShortcutForm
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onSubmitAndReset={lot ? undefined : () => submit(true)}
          onEscape={() => onOpenChange(false)}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5"><Label htmlFor="lot-code">Lot code</Label><Input id="lot-code" value={lotCode} onChange={(e) => setLotCode(e.target.value)} /></div>
            <div className="grid gap-1.5">
              <Label htmlFor="lot-weight">Extracted weight</Label>
              {useDerived ? (
                <div className="flex h-9 items-center justify-between gap-2 rounded-md border border-dashed px-3">
                  <span className="min-w-0 truncate text-sm">
                    {formatLbs(derivedLbs)}
                    <span className="text-muted-foreground">
                      {" "}· derived from {selectedHarvests.length}{" "}
                      {selectedHarvests.length === 1 ? "harvest" : "harvests"}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto shrink-0 p-0 text-xs"
                    onClick={() => {
                      // Seed the box with what it is overriding, so the
                      // override is an edit rather than a blank retype.
                      if (!weight.trim()) setWeight(`${derivedLbs} lb`);
                      setWeightSource("manual");
                    }}
                  >
                    Type a weight
                  </Button>
                </div>
              ) : (
                <>
                  <Input id="lot-weight" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder={units.units === "metric" ? "9 kg or 20 lb" : "20 lb or 9 kg"} />
                  {derivable && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto justify-start p-0 text-xs"
                      onClick={() => setWeightSource("derived")}
                    >
                      Use {formatLbs(derivedLbs)} derived from {selectedHarvests.length}{" "}
                      {selectedHarvests.length === 1 ? "harvest" : "harvests"}
                    </Button>
                  )}
                </>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lot-moisture">Extraction moisture %</Label>
              <Input id="lot-moisture" type="number" min="0" max="100" step="0.1" value={moisture} onChange={(e) => setMoisture(e.target.value)} placeholder="17.8" />
            </div>
          </div>
          {/* Where and when: the three inputs everything below is read from. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="lot-yard">Yard</Label>
              <Select value={claimApiaryId || "none"} onValueChange={(value) => setClaimApiaryId(value === "none" ? "" : value)}>
                <SelectTrigger id="lot-yard"><SelectValue placeholder="No yard claimed" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No yard claimed</SelectItem>
                  {(apiaries.data ?? []).map((apiary) => (
                    <SelectItem key={apiary.id} value={apiary.id}>{apiary.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lot-pulled">Frames pulled</Label>
              <Input id="lot-pulled" type="date" value={pulledOn} max={date || undefined} onChange={(e) => setPulledOn(e.target.value)} />
            </div>
            <div className="grid gap-1.5"><Label htmlFor="lot-date">Extraction date</Label><Input id="lot-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              Pick the yard and the pull date and the season, region, elevation,
              bloom notes and harvests fill in from what is already logged there.
              Anything you type stays yours.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="lot-season" className={labelClass}>Season<AutoHint on={autoFilled.has("season")} /></Label>
              <Input id="lot-season" value={season} onChange={(e) => { touch("season"); setSeason(e.target.value); }} placeholder="Summer 2026" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lot-region" className={labelClass}>Approximate region<AutoHint on={autoFilled.has("region")} /></Label>
              <Input id="lot-region" value={region} onChange={(e) => { touch("region"); setRegion(e.target.value); }} placeholder="Western New York" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lot-bottle-moisture">Bottling moisture %</Label>
              <Input id="lot-bottle-moisture" type="number" min="0" max="100" step="0.1" value={bottlingMoisture} onChange={(e) => setBottlingMoisture(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          {moistureError ? (
            <p className="text-sm text-destructive">{moistureError}</p>
          ) : null}
          {overrideOffered ? (
            <div className="grid gap-2 rounded-md border p-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={overrideAccepted}
                  onChange={(e) => setOverrideAccepted(e.target.checked)}
                />
                <span>Accept this reading anyway (recorded on the lot)</span>
              </label>
              {overrideAccepted ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="lot-moisture-override-reason">Reason</Label>
                  <Input
                    id="lot-moisture-override-reason"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="Going to mead; fermentation is the point"
                  />
                </div>
              ) : null}
            </div>
          ) : lot?.moistureOverrideReason ? (
            <p className="text-xs text-muted-foreground">
              Moisture override on record: {lot.moistureOverrideReason}
              {lot.moistureOverrideAt
                ? ` (${formatDate(lot.moistureOverrideAt)})`
                : ""}
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="lot-varietal" className={labelClass}>Varietal<AutoHint on={autoFilled.has("varietal")} /></Label>
              <Select
                value={varietalId || "none"}
                onValueChange={(value) => { touch("varietal"); setVarietalId(value === "none" ? "" : value); }}
              >
                <SelectTrigger id="lot-varietal"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {(varietals.data ?? []).map((varietal) => (
                    <SelectItem key={varietal.id} value={varietal.id}>{varietal.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              The varietal is this honey&rsquo;s name: it titles the public
              Honey Story and rolls the lot&rsquo;s balances up on the
              varietals page. An unassigned lot is shown by its lot code.
            </p>
          </div>
          <fieldset className="grid gap-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">
              Floral source claim
            </legend>
            <p className="text-xs text-muted-foreground">
              The declared source shared by the lot, the label, and the public
              Honey Story — e.g. &ldquo;Sourwood 2026, Yard B, 2100 ft&rdquo;.
              The claim species is the varietal above; the yard is the one
              chosen at the top.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="claim-year" className={labelClass}>Year<AutoHint on={autoFilled.has("year")} /></Label>
                <Input id="claim-year" type="number" min="1900" max="2100" value={claimYear} onChange={(e) => { touch("year"); setClaimYear(e.target.value); }} placeholder={String(new Date().getFullYear())} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="claim-elevation" className={labelClass}>Elevation ({preferredElevationSuffix(units.units)})<AutoHint on={autoFilled.has("elevation")} /></Label>
                <Input id="claim-elevation" inputMode="decimal" value={claimElevation} onChange={(e) => { touch("elevation"); setClaimElevation(e.target.value); }} placeholder={units.units === "us" ? "2100 ft" : "640 m"} />
              </div>
            </div>
          </fieldset>
          <div className="grid gap-1.5" data-testid="lot-harvests">
            <div className="flex items-center justify-between gap-2">
              <Label>Source hive harvests</Label>
              <span className="text-xs text-muted-foreground">
                {harvestIds.length} of {harvestRows.length} selected
              </span>
            </div>
            {harvestRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No harvests recorded yet.</p>
            ) : (
              <div className="grid gap-3 rounded-md border p-3">
                {visibleRows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {prefillKey
                      ? "No harvests fall in this pull window."
                      : "Pick a yard and pull date to suggest harvests, or show them all."}
                  </p>
                ) : null}
                {groupedRows.map((group) => (
                  <div key={group.name ?? "all"} className="grid gap-2">
                    {group.name ? (
                      <p className="text-xs font-medium text-muted-foreground">{group.name}</p>
                    ) : null}
                    <div className="grid gap-2 sm:grid-cols-2">
                      {group.rows.map((row) => (
                        <label
                          key={row.id}
                          data-testid="lot-harvest-option"
                          className={`flex items-center gap-2 text-sm ${row.claimed ? "text-muted-foreground" : ""}`}
                        >
                          <Checkbox
                            checked={harvestIds.includes(row.id)}
                            disabled={row.claimed}
                            onCheckedChange={(checked) => toggleHarvest(row.id, checked === true)}
                          />
                          <span className="truncate">
                            {group.name ? "" : `${row.apiaryName} · `}
                            {row.hiveName} · {formatDate(row.date)} · {formatLbs(row.calculatedHoneyWeight)}
                            {row.claimed ? " · already in a lot" : ""}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                {hiddenCount > 0 ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto justify-start p-0 text-xs"
                    aria-expanded={showAllHarvests}
                    onClick={() => setShowAllHarvests((current) => !current)}
                  >
                    {showAllHarvests ? (
                      <><ChevronUp /> Show fewer</>
                    ) : (
                      <><ChevronDown /> Show all {harvestRows.length} harvests</>
                    )}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="lot-bloom" className={labelClass}>Bloom observations<AutoHint on={autoFilled.has("bloom")} /></Label>
            <Textarea id="lot-bloom" value={bloom} onChange={(e) => { touch("bloom"); setBloom(e.target.value); }} rows={2} />
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="lot-story">Beekeeper story</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canDraft || drafting}
                title={canDraft ? undefined : "Pick the yard and the pull date first"}
                onClick={() => void draftStory()}
              >
                {drafting ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {drafting ? "Drafting…" : "Draft with AI"}
              </Button>
            </div>
            <Textarea id="lot-story" value={story} onChange={(e) => setStory(e.target.value)} rows={3} />
            {draftSources ? (
              <p className="text-xs text-muted-foreground" data-testid="story-draft-sources">
                AI draft from {draftSources.inspections} inspections,{" "}
                {draftSources.harvests} harvests, {draftSources.bloomObservations} bloom
                notes — edit before publishing
              </p>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label>Reorder link</Label><Input type="url" value={reorder} onChange={(e) => setReorder(e.target.value)} placeholder="https://…" /></div>
            <div className="grid gap-1.5"><Label>Curated photo IDs</Label><Input value={photoIds} onChange={(e) => setPhotoIds(e.target.value)} placeholder="Optional, comma separated" /></div>
          </div>
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy}><QrCode />{busy ? "Saving…" : lot ? "Save lot" : "Create lot & QR"}</Button></DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

function BottlingDialog({ lot, open, onOpenChange }: { lot: HarvestLot; open: boolean; onOpenChange: (open: boolean) => void }) {
  const inventory = useJarInventory();
  const create = useCreateBottlingRun(lot.id);
  const [date, setDate] = React.useState(todayISO());
  const [jarSizeId, setJarSizeId] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [pounds, setPounds] = React.useState("");
  const [serialize, setSerialize] = React.useState(false);
  const [moisture, setMoisture] = React.useState(
    lot.bottlingMoisturePct != null ? String(lot.bottlingMoisturePct) : "",
  );

  function resetDraft() {
    setDate(todayISO());
    setJarSizeId("");
    setQuantity("");
    setPounds("");
    setSerialize(false);
    setMoisture(lot.bottlingMoisturePct != null ? String(lot.bottlingMoisturePct) : "");
  }

  function submit(resetAfter = false) {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) return;
    // A run without a jar size creates no inventory movement; the API 400s.
    if (!jarSizeId) {
      toast.error("Pick a jar size — the run's jars have to land in inventory.");
      return;
    }
    create.mutate({
      bottledDate: date,
      jarSizeId,
      quantity: qty,
      honeyLbs: pounds.trim() ? Number(pounds) : undefined,
      serialize,
      moisturePct: moisture.trim() ? Number(moisture) : undefined,
    }, {
      onSuccess: () => {
        if (resetAfter) resetDraft();
        else onOpenChange(false);
      },
    });
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Bottle {lot.lotCode}</DialogTitle></DialogHeader>
        <ShortcutForm
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onSubmitAndReset={() => submit(true)}
          onEscape={() => onOpenChange(false)}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="grid gap-1.5"><Label>Jar size</Label><Select value={jarSizeId || undefined} onValueChange={setJarSizeId}><SelectTrigger><SelectValue placeholder="Select size" /></SelectTrigger><SelectContent>{(inventory.data ?? []).map((row) => <SelectItem key={row.jarSizeId} value={row.jarSizeId}>{row.label}</SelectItem>)}</SelectContent></Select></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label>Jars</Label><Input type="number" min="1" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
            <div className="grid gap-1.5"><Label>Honey used (lb)</Label><Input type="number" min="0" step="0.1" value={pounds} onChange={(e) => setPounds(e.target.value)} /></div>
          </div>
          <div className="grid gap-1.5">
            <Label>Bottling moisture % (optional)</Label>
            <Input type="number" min="0" max="100" step="0.1" value={moisture} onChange={(e) => setMoisture(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={serialize} onCheckedChange={(value) => setSerialize(value === true)} />Generate an individual serial number for every jar</label>
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={create.isPending}>{create.isPending ? "Saving…" : "Record bottling run"}</Button></DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
