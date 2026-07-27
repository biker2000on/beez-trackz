"use client";

import Link from "next/link";
import { ArrowLeft, Nfc, Printer, QrCode } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiaryHives } from "@/features/canvas/lib/use-canvas-data";
import { api } from "@/lib/api";

import { useApiary } from "./hooks";

const profiles = {
  "munbyn-2x1": { label: 'MUNBYN 2" × 1"', width: 2, height: 1 },
  "munbyn-3x2": { label: 'MUNBYN 3" × 2"', width: 3, height: 2 },
} as const;

type ProfileID = keyof typeof profiles;

interface HiveTag {
  url: string;
  nfc: { recordType: "url"; data: string };
}

type NDEFReaderConstructor = new () => {
  write(message: {
    records: Array<{ recordType: "url"; data: string }>;
  }): Promise<void>;
};

export function HiveLabelsPage({ apiaryId }: { apiaryId: string }) {
  const apiary = useApiary(apiaryId);
  const hives = useApiaryHives(apiaryId);
  const [profileID, setProfileID] = React.useState<ProfileID>("munbyn-2x1");
  const [selected, setSelected] = React.useState<Set<string> | null>(null);

  const profile = profiles[profileID];
  const activeSelection =
    selected ?? new Set((hives.data ?? []).map((hive) => hive.id));
  const selectedHives = (hives.data ?? []).filter((hive) =>
    activeSelection.has(hive.id),
  );

  async function writeNFC(hiveId: string) {
    const constructor = (
      globalThis as typeof globalThis & { NDEFReader?: NDEFReaderConstructor }
    ).NDEFReader;
    if (!constructor) {
      toast.error("Web NFC requires Chrome on a compatible Android device");
      return;
    }
    try {
      const tag = await api.get<HiveTag>(`/hives/${hiveId}/tag`);
      const reader = new constructor();
      await reader.write({
        records: [{ recordType: "url", data: tag.nfc.data }],
      });
      toast.success("NFC tag written");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not write NFC tag");
    }
  }

  if (apiary.isPending || hives.isPending) {
    return <Skeleton className="h-96 rounded-xl" />;
  }

  return (
    <div className="grid gap-5">
      <style>{`
        @media print {
          @page { size: ${profile.width}in ${profile.height}in; margin: 0; }
          body * { visibility: hidden !important; }
          #munbyn-print-area, #munbyn-print-area * { visibility: visible !important; }
          #munbyn-print-area {
            position: absolute;
            inset: 0 auto auto 0;
            display: block !important;
          }
          .munbyn-label {
            width: ${profile.width}in !important;
            height: ${profile.height}in !important;
            box-sizing: border-box;
            break-after: page;
            page-break-after: always;
            border: 0 !important;
            border-radius: 0 !important;
          }
        }
      `}</style>
      <header className="grid gap-3 print:hidden">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="-ml-3 w-fit text-muted-foreground"
        >
          <Link href={`/apiaries/${apiaryId}`}>
            <ArrowLeft />
            {apiary.data?.name ?? "Apiary"}
          </Link>
        </Button>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Hive tags</h1>
            <p className="text-sm text-muted-foreground">
              Print QR labels at exact MUNBYN stock size, or write the same
              authenticated hive URL to an NFC tag.
            </p>
          </div>
          <Button disabled={selectedHives.length === 0} onClick={() => window.print()}>
            <Printer />
            Print {selectedHives.length} label
            {selectedHives.length === 1 ? "" : "s"}
          </Button>
        </div>
      </header>

      <div className="grid gap-4 rounded-xl border p-4 print:hidden">
        <div className="grid max-w-xs gap-2">
          <Label>Label stock</Label>
          <Select
            value={profileID}
            onValueChange={(value: ProfileID) => setProfileID(value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(profiles).map(([id, value]) => (
                <SelectItem value={id} key={id}>
                  {value.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setSelected(new Set((hives.data ?? []).map((hive) => hive.id)))
            }
          >
            Select all
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
        <div className="divide-y rounded-lg border">
          {(hives.data ?? []).map((hive) => (
            <div className="flex items-center gap-3 p-3" key={hive.id}>
              <Checkbox
                checked={activeSelection.has(hive.id)}
                onCheckedChange={(checked) =>
                  setSelected((current) => {
                    const next = new Set(
                      current ??
                        (hives.data ?? []).map((currentHive) => currentHive.id),
                    );
                    if (checked) next.add(hive.id);
                    else next.delete(hive.id);
                    return next;
                  })
                }
                aria-label={`Print ${hive.positionLabel}`}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {hive.positionLabel}
                </p>
                <p className="text-xs capitalize text-muted-foreground">
                  {hive.status}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => writeNFC(hive.id)}
              >
                <Nfc />
                Write NFC
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div
        id="munbyn-print-area"
        className="flex flex-wrap gap-3 rounded-xl bg-muted/40 p-4 print:block print:bg-white print:p-0"
      >
        {selectedHives.map((hive) => (
          <div
            className="munbyn-label flex shrink-0 items-center gap-[0.08in] overflow-hidden rounded-sm border border-dashed border-muted-foreground/40 bg-white p-[0.08in] font-sans text-black"
            key={hive.id}
            style={{
              width: `${profile.width}in`,
              height: `${profile.height}in`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={`QR code for ${hive.positionLabel}`}
              src={`/api/v1/hives/${hive.id}/tag/qr?size=384`}
              className="aspect-square h-full max-w-[45%] object-contain"
            />
            <div className="min-w-0 flex-1">
              <QrCode className="mb-1 size-3" />
              <p
                className="truncate font-bold leading-none"
                style={{ fontSize: profileID === "munbyn-2x1" ? "12pt" : "18pt" }}
              >
                {hive.positionLabel}
              </p>
              <p
                className="mt-1 truncate leading-tight"
                style={{ fontSize: profileID === "munbyn-2x1" ? "7pt" : "10pt" }}
              >
                {apiary.data?.name}
              </p>
              <p
                className="mt-1 truncate font-mono leading-tight"
                style={{ fontSize: profileID === "munbyn-2x1" ? "5pt" : "7pt" }}
              >
                {hive.id.slice(0, 8)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
