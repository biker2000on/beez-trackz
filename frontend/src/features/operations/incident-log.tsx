"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { Textarea } from "@/components/ui/textarea";
import { useApiaries } from "@/features/apiaries/hooks";
import { useHives } from "@/features/hives/hooks";
import { todayInput, formatDate } from "@/features/hives/lib";
import { ApiError } from "@/lib/api";
import { useCreateFieldIncident, useFieldIncidents, type FieldIncident } from "./hooks";

const TYPES: FieldIncident["incidentType"][] = ["robbing", "yellowjackets", "bears", "skunks", "flood"];
export function IncidentLog() {
  const incidents = useFieldIncidents();
  const apiaries = useApiaries();
  const [open, setOpen] = React.useState(false);
  const [apiaryId, setApiaryId] = React.useState("");
  const hives = useHives({ apiaryId: apiaryId || undefined }, Boolean(apiaryId));
  const create = useCreateFieldIncident();
  const [type, setType] = React.useState<FieldIncident["incidentType"]>("robbing");
  const [date, setDate] = React.useState(todayInput());
  const [hiveId, setHiveId] = React.useState("yard");
  const [notes, setNotes] = React.useState("");
  async function submit(event: React.FormEvent) { event.preventDefault(); if (!apiaryId) { toast.error("Choose an apiary"); return; } try { await create.mutateAsync({ incidentType: type, incidentDate: date, apiaryId, hiveId: hiveId === "yard" ? undefined : hiveId, notes: notes.trim() || undefined }); toast.success("Incident recorded"); setOpen(false); setNotes(""); } catch(error) { toast.error(error instanceof ApiError ? error.message : "Could not record incident"); } }
  return <Card><CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle className="text-base">Incident log</CardTitle><Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus className="size-4" />Record incident</Button></CardHeader><CardContent>
    {(incidents.data?.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">No robbing, pest, wildlife, or flood incidents recorded.</p> : <ul className="grid gap-2">{incidents.data?.slice(0, 8).map((row) => <li className="rounded-md border px-3 py-2 text-sm" key={row.id}><p className="font-medium capitalize">{row.incidentType.replace("yellowjackets", "yellowjackets")} · {row.hiveName ?? row.apiaryName}</p><p className="text-xs text-muted-foreground">{formatDate(row.incidentDate)}{row.notes ? ` · ${row.notes}` : ""}</p></li>)}</ul>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Record field incident</DialogTitle><DialogDescription>An incident is history, not a hive status. Record it even when the colony remains active.</DialogDescription></DialogHeader><ShortcutForm className="grid gap-3" onSubmit={submit}><div className="grid grid-cols-2 gap-3"><div className="grid gap-1"><Label>Type</Label><Select value={type} onValueChange={(v) => setType(v as FieldIncident["incidentType"])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TYPES.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-1"><Label>Date</Label><Input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div></div><div className="grid grid-cols-2 gap-3"><div className="grid gap-1"><Label>Apiary</Label><Select value={apiaryId} onValueChange={(v) => { setApiaryId(v); setHiveId("yard"); }}><SelectTrigger><SelectValue placeholder="Choose yard" /></SelectTrigger><SelectContent>{apiaries.data?.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div><div className="grid gap-1"><Label>Hive or yard</Label><Select value={hiveId} onValueChange={setHiveId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="yard">Whole yard</SelectItem>{hives.data?.map((h) => <SelectItem key={h.id} value={h.id}>{h.positionLabel}</SelectItem>)}</SelectContent></Select></div></div><Textarea placeholder="What happened?" value={notes} onChange={(e) => setNotes(e.target.value)} /><DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={create.isPending}>{create.isPending ? "Saving…" : "Record"}</Button></DialogFooter></ShortcutForm></DialogContent></Dialog>
  </CardContent>
  </Card>;
}
