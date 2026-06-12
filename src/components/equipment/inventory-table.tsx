"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { bulkAdjustStock, updateStock } from "@/actions/equipment-v2";
import { deployEquipment, removeDeployment } from "@/actions/equipment-v2";
import { Pencil, ListChecks, ArrowRight, Undo2 } from "lucide-react";
import { useShortcut } from "@/components/keyboard/shortcut-provider";

export interface StockRow {
  id: string;
  typeId: string;
  typeName: string;
  typeCategory: string;
  totalOwned: number;
  deployed: number;
  available: number;
  storageLocation: string | null;
  frameCondition: string | null;
  framesPerBox: number | null;
}

export interface HiveOption {
  id: string;
  label: string;
}

export interface ActiveDeployment {
  id: string;
  stockId: string;
  hiveLabel: string;
  quantity: number;
}

const CATEGORY_ORDER = ["box", "frame", "cover", "bottom", "accessory", "other"];
const CATEGORY_LABELS: Record<string, string> = {
  box: "Boxes & Supers",
  frame: "Frames",
  cover: "Covers & Lids",
  bottom: "Bottom Boards",
  accessory: "Accessories",
  other: "Other",
};

export function InventoryTable({
  stock,
  hives,
  deployments,
}: {
  stock: StockRow[];
  hives: HiveOption[];
  deployments: ActiveDeployment[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [bulkMode, setBulkMode] = useState(false);
  const [bulkValues, setBulkValues] = useState<Record<string, string>>({});
  const [bulkReason, setBulkReason] = useState("");

  const [editRow, setEditRow] = useState<StockRow | null>(null);
  const [editLocation, setEditLocation] = useState("");

  const [deployRow, setDeployRow] = useState<StockRow | null>(null);
  const [deployHiveId, setDeployHiveId] = useState("");
  const [deployQty, setDeployQty] = useState("1");
  const [deployError, setDeployError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, StockRow[]>();
    for (const row of stock) {
      const list = map.get(row.typeCategory) ?? [];
      list.push(row);
      map.set(row.typeCategory, list);
    }
    return [...map.entries()].sort(
      (a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0])
    );
  }, [stock]);

  const deploymentsByStock = useMemo(() => {
    const map = new Map<string, ActiveDeployment[]>();
    for (const d of deployments) {
      const list = map.get(d.stockId) ?? [];
      list.push(d);
      map.set(d.stockId, list);
    }
    return map;
  }, [deployments]);

  useShortcut("b", "Toggle bulk count editing", "Inventory", () =>
    bulkMode ? setBulkMode(false) : startBulk()
  );

  const startBulk = () => {
    setBulkValues(Object.fromEntries(stock.map((s) => [s.id, String(s.totalOwned)])));
    setBulkReason("");
    setBulkMode(true);
  };

  const saveBulk = () => {
    const lines = stock
      .map((s) => ({ stockId: s.id, newTotal: parseInt(bulkValues[s.id]) }))
      .filter((l) => Number.isFinite(l.newTotal) && l.newTotal >= 0)
      .filter((l) => l.newTotal !== stock.find((s) => s.id === l.stockId)?.totalOwned);
    startTransition(async () => {
      if (lines.length > 0) {
        await bulkAdjustStock({ lines, reason: bulkReason || "bulk edit" });
      }
      setBulkMode(false);
      router.refresh();
    });
  };

  const changedCount = bulkMode
    ? stock.filter((s) => {
        const v = parseInt(bulkValues[s.id]);
        return Number.isFinite(v) && v !== s.totalOwned;
      }).length
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {!bulkMode ? (
          <Button variant="outline" size="sm" onClick={startBulk} className="gap-1.5">
            <ListChecks className="h-4 w-4" />
            Bulk edit counts
          </Button>
        ) : (
          <>
            <Input
              placeholder="Reason (e.g. annual recount)"
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
              className="h-9 w-56"
            />
            <Button size="sm" onClick={saveBulk} disabled={pending || changedCount === 0}>
              {pending ? "Saving…" : `Save ${changedCount} change${changedCount === 1 ? "" : "s"}`}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setBulkMode(false)}>
              Cancel
            </Button>
          </>
        )}
      </div>

      {grouped.map(([category, rows]) => (
        <div key={category}>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            {CATEGORY_LABELS[category] ?? category}
          </h2>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right w-24">Owned</TableHead>
                  <TableHead className="text-right w-24">In field</TableHead>
                  <TableHead className="text-right w-24">In storage</TableHead>
                  <TableHead className="hidden md:table-cell">Location</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">
                      {row.typeName}
                      {row.frameCondition && (
                        <Badge variant="outline" className="ml-1.5 font-normal capitalize">
                          {row.frameCondition}
                        </Badge>
                      )}
                      {row.framesPerBox != null && (
                        <span className="text-xs text-muted-foreground ml-1.5">
                          {row.framesPerBox}-frame
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {bulkMode ? (
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          className={`h-9 w-20 ml-auto text-right tabular-nums ${
                            parseInt(bulkValues[row.id]) !== row.totalOwned
                              ? "border-primary"
                              : ""
                          }`}
                          value={bulkValues[row.id] ?? ""}
                          onChange={(e) =>
                            setBulkValues((prev) => ({ ...prev, [row.id]: e.target.value }))
                          }
                        />
                      ) : (
                        <span className="font-semibold">{row.totalOwned}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.deployed}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.available}</TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">
                      {row.storageLocation ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Deploy to hive"
                          disabled={row.available <= 0 || hives.length === 0}
                          onClick={() => {
                            setDeployRow(row);
                            setDeployHiveId(hives[0]?.id ?? "");
                            setDeployQty("1");
                            setDeployError(null);
                          }}
                        >
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title="Edit location"
                          onClick={() => {
                            setEditRow(row);
                            setEditLocation(row.storageLocation ?? "");
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Active deployments under this category */}
          {rows.some((r) => (deploymentsByStock.get(r.id)?.length ?? 0) > 0) && (
            <div className="mt-2 space-y-1">
              {rows.flatMap((r) =>
                (deploymentsByStock.get(r.id) ?? []).map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center justify-between text-xs text-muted-foreground pl-1"
                  >
                    <span>
                      {d.quantity} × {r.typeName} on hive {d.hiveLabel}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          await removeDeployment(d.id);
                          router.refresh();
                        })
                      }
                    >
                      <Undo2 className="h-3 w-3" />
                      Return to storage
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      ))}

      {/* Edit location dialog */}
      <Dialog open={!!editRow} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{editRow?.typeName}</DialogTitle>
            <DialogDescription>Where is the spare stock kept?</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="stock-location">Storage location</Label>
            <Input
              id="stock-location"
              value={editLocation}
              onChange={(e) => setEditLocation(e.target.value)}
              placeholder="Barn, garage shelf…"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                if (!editRow) return;
                startTransition(async () => {
                  await updateStock(editRow.id, { storageLocation: editLocation });
                  setEditRow(null);
                  router.refresh();
                });
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deploy dialog */}
      <Dialog open={!!deployRow} onOpenChange={(o) => !o && setDeployRow(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Deploy {deployRow?.typeName}</DialogTitle>
            <DialogDescription>
              {deployRow?.available} available in storage.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {deployError && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {deployError}
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Hive</Label>
              <Select value={deployHiveId} onValueChange={setDeployHiveId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a hive" />
                </SelectTrigger>
                <SelectContent>
                  {hives.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deploy-qty">Quantity</Label>
              <Input
                id="deploy-qty"
                type="number"
                inputMode="numeric"
                min={1}
                max={deployRow?.available}
                value={deployQty}
                onChange={(e) => setDeployQty(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeployRow(null)}>
              Cancel
            </Button>
            <Button
              disabled={pending || !deployHiveId}
              onClick={() => {
                if (!deployRow) return;
                const formData = new FormData();
                formData.set("stockId", deployRow.id);
                formData.set("hiveId", deployHiveId);
                formData.set("quantity", deployQty || "1");
                startTransition(async () => {
                  const result = await deployEquipment(null, formData);
                  if (result && "error" in result && result.error) {
                    setDeployError(result.error);
                    return;
                  }
                  setDeployRow(null);
                  router.refresh();
                });
              }}
            >
              {pending ? "Deploying…" : "Deploy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
