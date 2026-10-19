"use client";

/**
 * The apiary record's shared frame (`/yard/apiaries/[id]/*`): one header,
 * one action bar, one tab strip, rendered by the route layout so Overview,
 * Map, Observations, Flora, Photos, Timeline, Labels, Bulk record and the
 * visit workspace all sit under the same skeleton. The tabs come from
 * `contextualNavRoutes`; the pages under this layout render only their body.
 */

import * as React from "react";
import Link from "next/link";
import {
  CircleDashed,
  Hexagon,
  MapPin,
  Mic,
  Pencil,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  RecordHeader,
  RecordHeaderSkeleton,
  useRecordActions,
  useRecordTabs,
} from "@/components/record/record-header";
import { useShortcut } from "@/components/shortcuts/provider";
import { useApiaryHives } from "@/features/canvas/lib/use-canvas-data";
import { formatElevationM } from "@/features/map/elevation";
import { formatForageRadius } from "@/features/map/forage-radius";
import { useUnits } from "@/lib/use-units";
import { apiaryRole, useAccessProfile } from "@/features/access/api";

import { ApiaryFormDialog } from "./apiary-form-dialog";
import { DeleteApiaryDialog } from "./delete-apiary-dialog";
import { FrostLine } from "./frost-summary";
import { useApiary, useApiaryWeather } from "./hooks";

export function ApiaryRecordLayout({
  apiaryId,
  children,
}: {
  apiaryId: string;
  children: React.ReactNode;
}) {
  const apiary = useApiary(apiaryId);
  const hives = useApiaryHives(apiaryId);
  // Same query key the overview uses, so the frost read costs no extra fetch.
  const weather = useApiaryWeather(apiaryId);
  const units = useUnits();
  const access = useAccessProfile();
  const isAdmin = access.data?.isAdmin === true;
  const canEdit = ["admin", "editor"].includes(
    apiaryRole(access.data, apiaryId) ?? "",
  );
  const tabs = useRecordTabs("/yard/apiaries", isAdmin, canEdit);
  const actions = useRecordActions("/yard/apiaries", isAdmin, canEdit);
  const [visit, ...otherActions] = actions;
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  useShortcut(
    "e",
    "Edit apiary",
    () => {
      if (canEdit) setEditOpen(true);
    },
    { enabled: canEdit },
  );

  if (apiary.isPending) {
    return (
      <div className="grid gap-5">
        <RecordHeaderSkeleton tabs={6} />
        {children}
      </div>
    );
  }

  if (apiary.isError) {
    return (
      <div className="grid min-h-64 place-items-center rounded-xl border border-dashed p-6 text-center">
        <div>
          <h1 className="text-lg font-semibold">Could not load this apiary</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            It may have been removed, or the server may be unavailable.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button asChild variant="outline">
              <Link href="/yard/apiaries">Back to apiaries</Link>
            </Button>
            <Button onClick={() => apiary.refetch()}>Retry</Button>
          </div>
        </div>
      </div>
    );
  }

  const detail = apiary.data;
  const hiveCount = hives.data?.length ?? 0;
  const elevation = formatElevationM(detail.elevationM, detail.elevationSource);
  const located = detail.latitude != null && detail.longitude != null;

  return (
    <div className="grid grid-cols-1 gap-5">
      <RecordHeader
        name={detail.name}
        tabs={tabs}
        tabsLabel="Apiary pages"
        context={[
          <span key="hives" className="inline-flex items-center gap-1.5">
            <Hexagon className="size-4" aria-hidden />
            {hives.isPending ? "…" : hiveCount} {hiveCount === 1 ? "hive" : "hives"}
          </span>,
          located && (
            <span key="pin" className="inline-flex items-center gap-1.5 font-mono text-xs">
              <MapPin className="size-4" aria-hidden />
              {detail.latitude!.toFixed(4)}, {detail.longitude!.toFixed(4)}
              {elevation ? ` · ${elevation}` : ""}
            </span>
          ),
          located && (
            <span key="forage" className="inline-flex items-center gap-1.5">
              <CircleDashed className="size-4" aria-hidden />
              {formatForageRadius(detail.forageRadiusM, units.units)} forage
            </span>
          ),
          // Frost sits next to elevation: together they are why two yards
          // 400 m apart behave differently.
          weather.data?.frost?.available && (
            <FrostLine key="frost" frost={weather.data.frost} />
          ),
        ]}
        primary={
          visit ? (
            <Button asChild>
              <Link href={visit.href}>
                <Mic className="size-4" />
                {visit.label}
              </Link>
            </Button>
          ) : undefined
        }
        secondary={
          canEdit ? (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" />
              Edit
            </Button>
          ) : undefined
        }
        more={
          otherActions.length > 0 || isAdmin ? (
            <>
              {otherActions.map((action) => (
                <DropdownMenuItem key={action.href} asChild>
                  <Link href={action.href}>
                    <Mic className="size-4" />
                    {action.label}
                  </Link>
                </DropdownMenuItem>
              ))}
              {isAdmin ? (
                <>
                  {otherActions.length > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="size-4" />
                    Delete apiary
                  </DropdownMenuItem>
                </>
              ) : null}
            </>
          ) : undefined
        }
      />

      {children}

      <ApiaryFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        apiary={detail}
      />
      <DeleteApiaryDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        apiaryId={apiaryId}
        apiaryName={detail.name}
      />
    </div>
  );
}
