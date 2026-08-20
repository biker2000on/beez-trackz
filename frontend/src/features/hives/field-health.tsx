"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Split, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useApiaries } from "@/features/apiaries/hooks";
import { ApiError } from "@/lib/api";
import { todayInput } from "./lib";
import { useCatchBoxes, useCreateCatchBox, useCreateColonyIntake, useHiveReadiness } from "./hooks";

export function FieldReadinessPanel() {
  const readiness = useHiveReadiness();
  const actionable = (readiness.data ?? []).filter((row) => row.call !== "neither");
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Swarm &amp; split readiness</CardTitle>
        <IntakeDialog />
      </CardHeader>
      <CardContent>
        {readiness.isPending ? (
          <p className="text-sm text-muted-foreground">Deriving current calls…</p>
        ) : actionable.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hive currently has enough recorded evidence for an action.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {actionable.map((row) => (
              <li key={row.hiveId} className="rounded-lg border p-3">
                <Link href={`/hives/${row.hiveId}`} className="font-medium hover:underline">
                  {row.hiveName} · {row.apiaryName}
                </Link>
                <p className="flex items-center gap-1 text-sm font-semibold">
                  {row.call === "will_swarm" ? <AlertTriangle className="size-4 text-destructive" /> : <Split className="size-4 text-primary" />}
                  {row.call === "will_swarm" ? "Will swarm" : "Ready to split"}
                </p>
                <p className="text-xs text-muted-foreground">{row.evidence.join(" · ")}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function CatchBoxesPanel() {
  const boxes = useCatchBoxes();
  const apiaries = useApiaries();
  const create = useCreateCatchBox();
  const [open, setOpen] = React.useState(false);
  const [apiaryId, setApiaryId] = React.useState("");
  const [kind, setKind] = React.useState<"yard" | "stand" | "fence_line">("yard");
  const [detail, setDetail] = React.useState("");
  const [date, setDate] = React.useState(todayInput());
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!apiaryId || (kind !== "yard" && !detail.trim())) { toast.error("Apiary and location detail are required"); return; }
    try { await create.mutateAsync({ apiaryId, locationKind: kind, dateSet: date, ...(kind === "stand" ? { standId: detail.trim() } : kind === "fence_line" ? { fenceLine: detail.trim() } : {}) }); toast.success("Catch box recorded"); setOpen(false); } catch (error) { toast.error(error instanceof ApiError ? error.message : "Could not record catch box"); }
  }
  const active = (boxes.data ?? []).filter((box) => !box.occupied);
  return <Card><CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle className="text-base">Catch boxes</CardTitle><Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus className="size-4" />Set catch box</Button></CardHeader><CardContent>{active.length === 0 ? <p className="text-sm text-muted-foreground">No empty catch boxes are currently set.</p> : <ul className="grid gap-2 sm:grid-cols-2">{active.map((box) => <li key={box.id} className="rounded-md border px-3 py-2 text-sm"><p className="font-medium">{box.apiaryName} · {box.standId ?? box.fenceLine ?? "yard"}</p><p className="text-xs text-muted-foreground">Set {box.dateSet.slice(0, 10)}{box.emptyAsOf ? ` · empty as of ${box.emptyAsOf.slice(0, 10)}` : ""}</p></li>)}</ul>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Set a catch box</DialogTitle><DialogDescription>Track bait hives so an empty box is not forgotten along a stand or fence line.</DialogDescription></DialogHeader><form onSubmit={submit} className="grid gap-3"><div className="grid grid-cols-2 gap-3"><div className="grid gap-1"><Label>Apiary</Label><Select value={apiaryId} onValueChange={setApiaryId}><SelectTrigger><SelectValue placeholder="Choose yard" /></SelectTrigger><SelectContent>{apiaries.data?.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-1"><Label>Location</Label><Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="yard">Yard</SelectItem><SelectItem value="stand">Stand</SelectItem><SelectItem value="fence_line">Fence line</SelectItem></SelectContent></Select></div></div>{kind !== "yard" && <div className="grid gap-1"><Label>{kind === "stand" ? "Stand" : "Fence-line description"}</Label><Input value={detail} onChange={(e) => setDetail(e.target.value)} /></div>}<div className="grid gap-1"><Label>Date set</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div><DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={create.isPending}>{create.isPending ? "Saving…" : "Set box"}</Button></DialogFooter></form></DialogContent></Dialog>
  </CardContent>
  </Card>;
}

function IntakeDialog() {
  const apiaries = useApiaries();
  const mutation = useCreateColonyIntake();
  const catchBoxes = useCatchBoxes();
  const [open, setOpen] = React.useState(false);
  const [apiaryId, setApiaryId] = React.useState("");
  const [source, setSource] = React.useState("package");
  const [positionLabel, setPositionLabel] = React.useState("");
  const [intakeDate, setIntakeDate] = React.useState(todayInput());
  const [startingStores, setStartingStores] = React.useState("");
  const [cost, setCost] = React.useState("");
  const [sourceDetail, setSourceDetail] = React.useState("");
  const [catchBoxId, setCatchBoxId] = React.useState("");
  const [notes, setNotes] = React.useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!apiaryId || !positionLabel.trim()) { toast.error("Apiary and hive position are required"); return; }
    try {
      await mutation.mutateAsync({ apiaryId, positionLabel: positionLabel.trim(), source: source as "package" | "nuc" | "split" | "swarm" | "catch_box" | "other", intakeDate, startingStores: startingStores.trim() || undefined, cost: Number(cost || 0), sourceDetail: sourceDetail.trim() || undefined, catchBoxId: source === "catch_box" && catchBoxId ? catchBoxId : undefined, notes: notes.trim() || undefined });
      toast.success("Colony intake recorded with hive, queen cohort, and expense");
      setOpen(false);
    } catch (error) { toast.error(error instanceof ApiError ? error.message : "Could not record intake"); }
  }
  return <>
    <Button size="sm" onClick={() => setOpen(true)}><Plus className="size-4" />Colony intake</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Colony intake</DialogTitle><DialogDescription>Creates the hive, bees/queens expense, and queen-line winter cohort together.</DialogDescription></DialogHeader>
      <form className="grid gap-3" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3"><div className="grid gap-1"><Label>Apiary</Label><Select value={apiaryId} onValueChange={setApiaryId}><SelectTrigger><SelectValue placeholder="Choose yard" /></SelectTrigger><SelectContent>{apiaries.data?.map((a) => <SelectItem value={a.id} key={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-1"><Label>Hive position</Label><Input value={positionLabel} onChange={(e) => setPositionLabel(e.target.value)} /></div></div>
        <div className="grid grid-cols-2 gap-3"><div className="grid gap-1"><Label>Source</Label><Select value={source} onValueChange={setSource}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["package","nuc","split","swarm","catch_box","other"].map((v) => <SelectItem value={v} key={v}>{v.replace("_", " ")}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-1"><Label>Date</Label><Input type="date" value={intakeDate} onChange={(e) => setIntakeDate(e.target.value)} /></div></div>
        {source === "catch_box" && <div className="grid gap-1"><Label>Occupied catch box</Label><Select value={catchBoxId} onValueChange={setCatchBoxId}><SelectTrigger><SelectValue placeholder="Choose box" /></SelectTrigger><SelectContent>{catchBoxes.data?.filter((box) => !box.occupied && box.apiaryId === apiaryId).map((box) => <SelectItem key={box.id} value={box.id}>{box.standId ?? box.fenceLine ?? box.apiaryName}</SelectItem>)}</SelectContent></Select></div>}
        <div className="grid grid-cols-2 gap-3"><div className="grid gap-1"><Label>Starting stores</Label><Input placeholder="e.g. 2 frames honey" value={startingStores} onChange={(e) => setStartingStores(e.target.value)} /></div><div className="grid gap-1"><Label>Cost</Label><Input inputMode="decimal" placeholder="0.00" value={cost} onChange={(e) => setCost(e.target.value)} /></div></div>
        <div className="grid gap-1"><Label>Source / vendor</Label><Input value={sourceDetail} onChange={(e) => setSourceDetail(e.target.value)} /></div><Textarea placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Record intake"}</Button></DialogFooter>
      </form></DialogContent></Dialog>
  </>;
}
