"use client";

import * as React from "react";
import { Scale, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/features/hives/lib";
import { useUnits } from "@/lib/use-units";

import { ScaleChart } from "./scale-chart";
import {
  SCALE_VENDOR_LABELS,
  useCreateScale,
  useDeleteScale,
  useScaleSeries,
  useScales,
  useUploadScaleReadings,
  type ScaleVendor,
  type YardScale,
} from "./scale-hooks";

/**
 * Scale hives. One scale per yard is enough — a scale may name a hive, but it
 * does not have to. Ingest is a CSV export from the vendor's app; there is
 * deliberately no MQTT broker to run in a bee yard with no power.
 */

const RANGE_DAYS = [
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "180", label: "Season", days: 180 },
  { id: "365", label: "Year", days: 365 },
] as const;

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function ScaleRow({
  scale,
  apiaryId,
  canEdit,
}: {
  scale: YardScale;
  apiaryId: string;
  canEdit: boolean;
}) {
  const units = useUnits();
  const deleteScale = useDeleteScale(apiaryId);
  const upload = useUploadScaleReadings(apiaryId);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [weightUnit, setWeightUnit] = React.useState<"lb" | "kg">("lb");

  async function onFile(file: File | undefined) {
    if (!file) return;
    try {
      const result = await upload.mutateAsync({
        scaleId: scale.id,
        file,
        weightUnit,
      });
      toast.success(
        `${result.daysStored} ${result.daysStored === 1 ? "day" : "days"} imported (${formatDate(result.firstDate)} – ${formatDate(result.lastDate)})`,
        result.rowsSkipped
          ? {
              description: `${result.rowsParsed} rows read, ${result.rowsSkipped} skipped as unreadable.`,
            }
          : undefined,
      );
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not import that CSV",
      );
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onDelete() {
    try {
      await deleteScale.mutateAsync(scale.id);
      toast.success("Scale removed");
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not remove the scale",
      );
    }
  }

  return (
    <li className="grid gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {scale.name}
            <Badge variant="outline">{SCALE_VENDOR_LABELS[scale.vendor]}</Badge>
            {scale.hiveLabel ? (
              <Badge variant="outline">{scale.hiveLabel}</Badge>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {scale.readingCount === 0
              ? "No readings yet — upload a CSV export."
              : `${scale.readingCount} days · ${formatDate(scale.firstReading ?? "")} – ${formatDate(scale.lastReading ?? "")}`}
            {scale.lastWeightLb != null
              ? ` · last ${units.formatHoney(scale.lastWeightLb)}`
              : ""}
          </p>
        </div>
        {canEdit ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${scale.name}`}
            onClick={onDelete}
            disabled={deleteScale.isPending}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={upload.isPending}
          >
            <Upload className="size-4" />
            {upload.isPending ? "Importing…" : "Import CSV"}
          </Button>
          <Select
            value={weightUnit}
            onValueChange={(next) => setWeightUnit(next as "lb" | "kg")}
          >
            <SelectTrigger className="w-40" aria-label="CSV weight unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="lb">Weights in lb</SelectItem>
              <SelectItem value="kg">Weights in kg</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            Used only when the CSV header does not name a unit. Re-importing
            the same file is safe.
          </span>
        </div>
      ) : null}
    </li>
  );
}

function AddScaleForm({ apiaryId }: { apiaryId: string }) {
  const createScale = useCreateScale(apiaryId);
  const [name, setName] = React.useState("");
  const [vendor, setVendor] = React.useState<ScaleVendor>("broodminder");
  const [deviceId, setDeviceId] = React.useState("");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (name.trim() === "") {
      toast.error("Give the scale a name.");
      return;
    }
    try {
      await createScale.mutateAsync({
        name: name.trim(),
        vendor,
        deviceId: deviceId.trim() === "" ? null : deviceId.trim(),
      });
      toast.success("Scale added");
      setName("");
      setDeviceId("");
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not add the scale",
      );
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3">
      <div className="grid gap-2">
        <Label htmlFor="scale-name">Scale name</Label>
        <Input
          id="scale-name"
          placeholder="e.g. Home Yard scale"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="scale-vendor">Vendor</Label>
        <Select
          value={vendor}
          onValueChange={(next) => setVendor(next as ScaleVendor)}
        >
          <SelectTrigger id="scale-vendor">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(
              Object.keys(SCALE_VENDOR_LABELS) as ScaleVendor[]
            ).map((id) => (
              <SelectItem key={id} value={id}>
                {SCALE_VENDOR_LABELS[id]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="scale-device">Device ID</Label>
        <Input
          id="scale-device"
          placeholder="Optional"
          value={deviceId}
          onChange={(event) => setDeviceId(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        className="justify-self-start"
        disabled={createScale.isPending}
      >
        {createScale.isPending ? "Adding…" : "Add scale"}
      </Button>
    </form>
  );
}

export function ScalePanel({
  apiaryId,
  canEdit = true,
}: {
  apiaryId: string;
  canEdit?: boolean;
}) {
  const [rangeId, setRangeId] =
    React.useState<(typeof RANGE_DAYS)[number]["id"]>("180");
  const range = RANGE_DAYS.find((entry) => entry.id === rangeId) ?? RANGE_DAYS[2];
  const scales = useScales(apiaryId);
  const series = useScaleSeries(apiaryId, { from: isoDaysAgo(range.days) });

  const hasScales = (scales.data?.length ?? 0) > 0;

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Scale className="size-4 text-primary" />
              Yard scale
            </CardTitle>
            <CardDescription>
              Daily weight overlaid on the bloom windows and inspections that
              explain it. CSV import from your scale&apos;s app — one scale per
              yard is enough.
            </CardDescription>
          </div>
          {hasScales ? (
            <div className="flex shrink-0 flex-wrap gap-2">
              {RANGE_DAYS.map((entry) => (
                <Button
                  key={entry.id}
                  type="button"
                  size="sm"
                  variant={entry.id === rangeId ? "default" : "outline"}
                  onClick={() => setRangeId(entry.id)}
                >
                  {entry.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {scales.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : scales.isError ? (
          <p className="text-sm text-muted-foreground">
            Could not load the scales for this yard.
          </p>
        ) : (
          <>
            {hasScales ? (
              series.isPending ? (
                <Skeleton className="h-56 w-full" />
              ) : series.data ? (
                <>
                  <ScaleChart data={series.data} />
                  {series.data.scales
                    .filter((scale) => scale.points.length > 0)
                    .map((scale) => (
                      <p key={scale.scaleId} className="text-sm">
                        <span className="font-medium">{scale.name}:</span>{" "}
                        {scale.latestSummary}
                      </p>
                    ))}
                </>
              ) : null
            ) : (
              <p className="text-sm text-muted-foreground">
                No scale on this yard yet.
                {canEdit
                  ? " Add one below, then import a Broodminder or HiveTracks CSV export."
                  : ""}
              </p>
            )}

            {hasScales ? (
              <ul className="grid gap-2">
                {scales.data?.map((scale) => (
                  <ScaleRow
                    key={scale.id}
                    scale={scale}
                    apiaryId={apiaryId}
                    canEdit={canEdit}
                  />
                ))}
              </ul>
            ) : null}

            {canEdit ? <AddScaleForm apiaryId={apiaryId} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
