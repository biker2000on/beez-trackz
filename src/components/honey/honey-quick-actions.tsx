"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  recordJarring,
  recordBulkMovement,
  recordGiveAway,
  recordSale,
  adjustJarCounts,
} from "@/actions/honey";
import {
  JarLinesEditor,
  parseLines,
  type EditorLine,
  type JarSizeOption,
} from "./jar-lines-editor";
import { useShortcut } from "@/components/keyboard/shortcut-provider";
import { Package, DollarSign, FlaskConical, Trash2, Gift, SlidersHorizontal } from "lucide-react";

type DialogKind = null | "jar" | "sale" | "bulk_use" | "loss" | "give" | "adjust";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function HoneyQuickActions({
  sizes,
  locations,
}: {
  sizes: JarSizeOption[];
  locations: string[];
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared form state, reset on open
  const [date, setDate] = useState(today());
  const [lines, setLines] = useState<EditorLine[]>([]);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [location, setLocation] = useState("");
  const [customer, setCustomer] = useState("");
  const [lossLbs, setLossLbs] = useState("");

  const open = (kind: Exclude<DialogKind, null>) => {
    setDate(today());
    setLines(
      kind === "adjust"
        ? sizes.map((s) => ({ jarSizeId: s.id, quantity: "" }))
        : [
            {
              jarSizeId: sizes[0]?.id ?? "",
              quantity: "",
              ...(kind === "sale"
                ? { unitPrice: sizes[0]?.defaultPrice != null ? String(sizes[0].defaultPrice) : "" }
                : {}),
            },
          ]
    );
    setAmount("");
    setReason("");
    setNotes("");
    setLocation("");
    setCustomer("");
    setLossLbs("");
    setError(null);
    setDialog(kind);
  };

  const submit = async (fn: () => Promise<{ error?: string; success?: boolean }>) => {
    setPending(true);
    setError(null);
    try {
      const result = await fn();
      if (result?.error) {
        setError(result.error);
        return;
      }
      setDialog(null);
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  useShortcut("j", "Jar honey", "Honey", () => open("jar"));
  useShortcut("s", "Record sale", "Honey", () => open("sale"));
  useShortcut("u", "Bulk use", "Honey", () => open("bulk_use"));
  useShortcut("l", "Record loss", "Honey", () => open("loss"));
  useShortcut("v", "Give away", "Honey", () => open("give"));
  useShortcut("a", "Adjust jar counts", "Honey", () => open("adjust"));

  const saleTotal = lines.reduce(
    (sum, l) => sum + (parseInt(l.quantity) || 0) * (parseFloat(l.unitPrice ?? "") || 0),
    0
  );

  const closeProps = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => open("jar")} className="gap-1.5">
          <Package className="h-4 w-4" />
          Jar Honey
        </Button>
        <Button onClick={() => open("sale")} className="gap-1.5">
          <DollarSign className="h-4 w-4" />
          Record Sale
        </Button>
        <Button variant="outline" onClick={() => open("bulk_use")} className="gap-1.5">
          <FlaskConical className="h-4 w-4" />
          Bulk Use
        </Button>
        <Button variant="outline" onClick={() => open("loss")} className="gap-1.5">
          <Trash2 className="h-4 w-4" />
          Loss
        </Button>
        <Button variant="outline" onClick={() => open("give")} className="gap-1.5">
          <Gift className="h-4 w-4" />
          Give Away
        </Button>
        <Button variant="outline" onClick={() => open("adjust")} className="gap-1.5">
          <SlidersHorizontal className="h-4 w-4" />
          Adjust Jars
        </Button>
      </div>

      {/* ---- Jar honey ---- */}
      <Dialog open={dialog === "jar"} onOpenChange={closeProps}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Jar honey</DialogTitle>
            <DialogDescription>
              One entry per jarring session — add a line per size filled, plus
              any sticky loss from the same session.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {error && <FormError message={error} />}
            <DateField value={date} onChange={setDate} />
            <JarLinesEditor sizes={sizes} lines={lines} onChange={setLines} />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="jar-loss">Loss (lbs, optional)</Label>
                <Input
                  id="jar-loss"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.1"
                  value={lossLbs}
                  onChange={(e) => setLossLbs(e.target.value)}
                  placeholder="0.0"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="jar-notes">Notes</Label>
                <Input
                  id="jar-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                submit(() =>
                  recordJarring({
                    date,
                    lines: parseLines(lines),
                    lossLbs: parseFloat(lossLbs) || undefined,
                    notes,
                  })
                )
              }
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Sale ---- */}
      <Dialog open={dialog === "sale"} onOpenChange={closeProps}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Record sale</DialogTitle>
            <DialogDescription>
              Prices prefill from the jar-size price book.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {error && <FormError message={error} />}
            <div className="grid grid-cols-2 gap-3">
              <DateField value={date} onChange={setDate} />
              <div className="space-y-1.5">
                <Label htmlFor="sale-location">Location</Label>
                <Input
                  id="sale-location"
                  list="sale-locations"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Home, market…"
                />
                <datalist id="sale-locations">
                  {locations.map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
              </div>
            </div>
            <JarLinesEditor
              sizes={sizes}
              lines={lines}
              onChange={setLines}
              withPrice
              showOnHand
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="sale-customer">Customer</Label>
                <Input
                  id="sale-customer"
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Total</Label>
                <p className="h-10 flex items-center font-semibold tabular-nums">
                  ${saleTotal.toFixed(2)}
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                submit(() =>
                  recordSale({
                    date,
                    location,
                    customerName: customer,
                    lines: parseLines(lines).map((l) => ({
                      jarSizeId: l.jarSizeId,
                      quantity: l.quantity,
                      unitPrice: l.unitPrice ?? 0,
                    })),
                    notes,
                  })
                )
              }
            >
              {pending ? "Saving…" : "Save sale"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Bulk use / loss ---- */}
      <Dialog open={dialog === "bulk_use" || dialog === "loss"} onOpenChange={closeProps}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{dialog === "loss" ? "Record loss" : "Bulk use"}</DialogTitle>
            <DialogDescription>
              {dialog === "loss"
                ? "Bulk honey written off — stickiness, cleaning, spills."
                : "Bulk honey used directly — mead, baking, gifts from the bucket."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {error && <FormError message={error} />}
            <DateField value={date} onChange={setDate} />
            <div className="space-y-1.5">
              <Label htmlFor="bulk-amount">Amount (lbs)</Label>
              <Input
                id="bulk-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-reason">Reason</Label>
              <Input
                id="bulk-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={dialog === "loss" ? "Cleaning, stickiness…" : "Mead, baking…"}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                submit(() =>
                  recordBulkMovement({
                    date,
                    kind: dialog === "loss" ? "loss" : "bulk_use",
                    amountLbs: parseFloat(amount) || 0,
                    reason,
                  })
                )
              }
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Give away ---- */}
      <Dialog open={dialog === "give"} onOpenChange={closeProps}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Give away / home use</DialogTitle>
            <DialogDescription>
              Jars consumed at home or given away — removed from inventory, no
              revenue.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {error && <FormError message={error} />}
            <DateField value={date} onChange={setDate} />
            <JarLinesEditor sizes={sizes} lines={lines} onChange={setLines} showOnHand />
            <div className="space-y-1.5">
              <Label htmlFor="give-reason">Reason</Label>
              <Input
                id="give-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Family, gift, home use…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                submit(() => recordGiveAway({ date, lines: parseLines(lines), reason }))
              }
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Adjust counts (bulk) ---- */}
      <Dialog open={dialog === "adjust"} onOpenChange={closeProps}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Adjust jar counts</DialogTitle>
            <DialogDescription>
              Enter +/- corrections per size (e.g. -2 for breakage, +3 found in
              the pantry). Blank lines are skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {error && <FormError message={error} />}
            <DateField value={date} onChange={setDate} />
            <div className="space-y-2">
              {lines.map((line, index) => {
                const size = sizes.find((s) => s.id === line.jarSizeId);
                return (
                  <div key={line.jarSizeId} className="flex items-center gap-3">
                    <span className="flex-1 text-sm">
                      {size?.label}
                      {size?.onHand != null && (
                        <span className="text-muted-foreground"> — {size.onHand} on hand</span>
                      )}
                    </span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      placeholder="±0"
                      className="w-24 h-10 text-right tabular-nums"
                      value={line.quantity}
                      onChange={(e) =>
                        setLines(
                          lines.map((l, i) =>
                            i === index ? { ...l, quantity: e.target.value } : l
                          )
                        )
                      }
                    />
                  </div>
                );
              })}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adjust-reason">Reason</Label>
              <Input
                id="adjust-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Recount, breakage…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                submit(() =>
                  adjustJarCounts({
                    date,
                    reason,
                    lines: lines
                      .map((l) => ({
                        jarSizeId: l.jarSizeId,
                        delta: parseInt(l.quantity) || 0,
                      }))
                      .filter((l) => l.delta !== 0),
                  })
                )
              }
            >
              {pending ? "Saving…" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="qa-date">Date</Label>
      <Input id="qa-date" type="date" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}
