"use client";

import * as React from "react";
import Link from "next/link";
import {
  ExternalLink,
  PackagePlus,
  Pencil,
  Plus,
  QrCode,
  ScanSearch,
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
import { useHarvests, useJarInventory } from "@/features/honey/hooks";
import { todayISO } from "@/features/honey/format";
import {
  useCreateBottlingRun,
  useCreateHarvestLot,
  useHarvestLots,
  useUpdateHarvestLot,
  type HarvestLot,
} from "./api";

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
          <Link href="/harvest/serials">
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
                    <p className="font-medium">{lot.honeyVariety ?? "Honey"}{lot.season ? ` · ${lot.season}` : ""}</p>
                    <p className="text-xs text-muted-foreground">
                      {lot.apiaryRegion ?? (lot.sourceApiaries.join(", ") || "Region not published")}
                    </p>
                    {(lot.moisturePct != null || lot.bottlingMoisturePct != null) && (
                      <p className="text-xs text-muted-foreground">
                        {lot.moisturePct != null ? `Extracted ${lot.moisturePct}%` : "Extraction moisture not recorded"}
                        {lot.bottlingMoisturePct != null ? ` · Bottled ${lot.bottlingMoisturePct}%` : ""}
                      </p>
                    )}
                    {lot.lockout?.locked && (
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                        {lot.lockout.message}
                      </p>
                    )}
                    <Link href={`/honey/${lot.publicSlug}`} target="_blank" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
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
  const [weight, setWeight] = React.useState(
    () => (lot ? String(lot.honeyWeightLbs) : ""),
  );
  const [variety, setVariety] = React.useState(lot?.honeyVariety ?? "");
  const [season, setSeason] = React.useState(lot?.season ?? "");
  const [region, setRegion] = React.useState(lot?.apiaryRegion ?? "");
  const [bloom, setBloom] = React.useState(lot?.bloomNotes ?? "");
  const [story, setStory] = React.useState(lot?.beekeeperStory ?? "");
  const [reorder, setReorder] = React.useState(lot?.reorderUrl ?? "");
  const [harvestIds, setHarvestIds] = React.useState<string[]>(
    () => lot?.sourceHarvestIds ?? [],
  );
  const [photoIds, setPhotoIds] = React.useState(
    () => lot?.photos.map((photo) => photo.id).join(", ") ?? "",
  );
  const [moisture, setMoisture] = React.useState(
    () => (lot?.moisturePct != null ? String(lot.moisturePct) : ""),
  );
  const [bottlingMoisture, setBottlingMoisture] = React.useState(
    () => (lot?.bottlingMoisturePct != null ? String(lot.bottlingMoisturePct) : ""),
  );

  function resetDraft() {
    setLotCode("");
    setDate(todayISO());
    setWeight("");
    setVariety("");
    setSeason("");
    setRegion("");
    setBloom("");
    setStory("");
    setReorder("");
    setHarvestIds([]);
    setPhotoIds("");
    setMoisture("");
    setBottlingMoisture("");
  }

  function submit(resetAfter = false) {
    const pounds = Number(weight);
    if (!lotCode.trim() || !date || !Number.isFinite(pounds) || pounds < 0) return;
    const payload = {
      lotCode: lotCode.trim(),
      extractionDate: date,
      honeyWeightLbs: pounds,
      honeyVariety: variety.trim() || undefined,
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
    };
    if (lot) {
      // Keep the published slug stable so printed QR labels keep resolving.
      update.mutate(
        { id: lot.id, publicSlug: lot.publicSlug, ...payload },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      create.mutate(payload, {
        onSuccess: () => {
          if (resetAfter) resetDraft();
          else onOpenChange(false);
        },
      });
    }
  }

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
            <div className="grid gap-1.5"><Label htmlFor="lot-date">Extraction date</Label><Input id="lot-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="lot-weight">Extracted lb</Label><Input id="lot-weight" type="number" min="0" step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)} /></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="lot-moisture">Extraction moisture %</Label>
              <Input id="lot-moisture" type="number" min="0" max="100" step="0.1" value={moisture} onChange={(e) => setMoisture(e.target.value)} placeholder="17.8" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lot-bottle-moisture">Bottling moisture % (optional)</Label>
              <Input id="lot-bottle-moisture" type="number" min="0" max="100" step="0.1" value={bottlingMoisture} onChange={(e) => setBottlingMoisture(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5"><Label>Variety</Label><Input value={variety} onChange={(e) => setVariety(e.target.value)} placeholder="Wildflower" /></div>
            <div className="grid gap-1.5"><Label>Season</Label><Input value={season} onChange={(e) => setSeason(e.target.value)} placeholder="Summer 2026" /></div>
            <div className="grid gap-1.5"><Label>Approximate region</Label><Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Western New York" /></div>
          </div>
          <div className="grid gap-1.5">
            <Label>Source hive harvests</Label>
            <div className="grid max-h-36 gap-2 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">
              {(harvests ?? []).map((harvest) => (
                <label key={harvest.id} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={harvestIds.includes(harvest.id)} onCheckedChange={(checked) => setHarvestIds((current) => checked ? [...current, harvest.id] : current.filter((id) => id !== harvest.id))} />
                  {harvest.apiaryName} · {harvest.hiveName} · {formatLbs(harvest.calculatedHoneyWeight)}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-1.5"><Label>Bloom observations</Label><Textarea value={bloom} onChange={(e) => setBloom(e.target.value)} rows={2} /></div>
          <div className="grid gap-1.5"><Label>Beekeeper story</Label><Textarea value={story} onChange={(e) => setStory(e.target.value)} rows={3} /></div>
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
