"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { todayInput } from "./lib";
import { useSaveDeadoutAutopsy } from "./hooks";

export function DeadoutAutopsyDialog({ open, onOpenChange, hiveId, hiveName }: { open: boolean; onOpenChange: (open: boolean) => void; hiveId: string; hiveName: string }) {
  const mutation = useSaveDeadoutAutopsy();
  const [date, setDate] = React.useState(todayInput());
  const [stores, setStores] = React.useState("");
  const [cluster, setCluster] = React.useState("");
  const [mites, setMites] = React.useState("");
  const [queen, setQueen] = React.useState("unknown");
  const [moisture, setMoisture] = React.useState(false);
  const [mold, setMold] = React.useState(false);
  const [notes, setNotes] = React.useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await mutation.mutateAsync({ hiveId, autopsyDate: date, storesLeft: stores.trim() || null, clusterPosition: cluster.trim() || null, lastFallMiteLoad: mites === "" ? null : Number(mites), queenStatus: queen as "unknown", moisture, mold, notes: notes.trim() || null });
      toast.success("Deadout and autopsy recorded"); onOpenChange(false);
    } catch (error) { toast.error(error instanceof ApiError ? error.message : "Could not record autopsy"); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Deadout autopsy · {hiveName}</DialogTitle><DialogDescription>Record what the colony left behind before archiving it. These fields make winter losses comparable.</DialogDescription></DialogHeader><form onSubmit={submit} className="grid gap-3">
    <div className="grid grid-cols-2 gap-3"><div className="grid gap-1"><Label>Date</Label><Input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div><div className="grid gap-1"><Label>Queen status</Label><Select value={queen} onValueChange={setQueen}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="present">Present</SelectItem><SelectItem value="absent">Absent</SelectItem><SelectItem value="unknown">Unknown</SelectItem></SelectContent></Select></div></div>
    <div className="grid grid-cols-2 gap-3"><div className="grid gap-1"><Label>Stores left</Label><Input placeholder="e.g. full super, none" value={stores} onChange={(e) => setStores(e.target.value)} /></div><div className="grid gap-1"><Label>Cluster position</Label><Input placeholder="e.g. top left" value={cluster} onChange={(e) => setCluster(e.target.value)} /></div></div>
    <div className="grid gap-1"><Label>Last fall mite load</Label><Input type="number" min="0" step="0.01" value={mites} onChange={(e) => setMites(e.target.value)} /></div>
    <div className="flex gap-5"><label className="flex items-center gap-2 text-sm"><Checkbox checked={moisture} onCheckedChange={(v) => setMoisture(v === true)} />Moisture</label><label className="flex items-center gap-2 text-sm"><Checkbox checked={mold} onCheckedChange={(v) => setMold(v === true)} />Mold</label></div>
    <Textarea placeholder="Other findings" value={notes} onChange={(e) => setNotes(e.target.value)} />
    <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" variant="destructive" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Record deadout & autopsy"}</Button></DialogFooter>
  </form></DialogContent></Dialog>;
}
