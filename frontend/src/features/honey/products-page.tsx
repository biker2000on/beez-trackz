"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useExpenses, useHarvestLots } from "@/features/commerce/api";
import { formatDate, formatLbs, formatMoney, parseNum, todayISO } from "./format";
import {
  useApiaryOptions,
  useCreateProduct,
  useCreateProductBatch,
  useCreatePropolisHarvest,
  useHiveOptions,
  useProductBatches,
  useProductCatalog,
  usePropolisHarvests,
} from "./hooks";
import type { CatalogProductKind } from "./types";

const PRODUCT_KINDS: { value: CatalogProductKind; label: string }[] = [
  { value: "creamed_honey", label: "Creamed honey" },
  { value: "hot_honey", label: "Hot honey" },
  { value: "mead", label: "Mead" },
  { value: "propolis", label: "Propolis" },
  { value: "tincture", label: "Tincture" },
];

const BATCH_KINDS = PRODUCT_KINDS.filter((kind) => kind.value !== "propolis");

function kindLabel(kind: string) {
  return PRODUCT_KINDS.find((item) => item.value === kind)?.label ?? kind.replaceAll("_", " ");
}

export function HiveProductsPage() {
  const catalog = useProductCatalog();
  const harvests = usePropolisHarvests();
  const batches = useProductBatches();

  if (catalog.isPending || harvests.isPending || batches.isPending) {
    return <Skeleton className="h-72" />;
  }
  if (catalog.isError || harvests.isError || batches.isError) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Could not load hive products.
      </p>
    );
  }

  return (
    <div className="grid gap-8">
      <section className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Catalog</h2>
            <p className="text-sm text-muted-foreground">
              Finished SKUs sold on the same receipt as jars, nucs, and gear.
            </p>
          </div>
          <AddProductDialog />
        </div>
        {(catalog.data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No catalog items yet.</p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalog.data?.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="capitalize">{kindLabel(item.kind)}</TableCell>
                    <TableCell>{item.sizeLabel ?? item.unit}</TableCell>
                    <TableCell>{formatMoney(item.defaultPrice)}</TableCell>
                    <TableCell className="text-right tabular-nums">{item.onHand}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {(catalog.data?.propolisOnHandGrams ?? 0) > 0 && (
          <p className="text-sm text-muted-foreground">
            Raw propolis on hand: {catalog.data?.propolisOnHandGrams.toFixed(1)} g
            (does not change honey pounds).
          </p>
        )}
      </section>

      <section className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Propolis harvests</h2>
            <p className="text-sm text-muted-foreground">
              Scraped from a hive or yard. Never writes to the honey ledger.
            </p>
          </div>
          <AddPropolisDialog />
        </div>
        {harvests.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No propolis harvests yet.</p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {harvests.data.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{formatDate(row.date)}</TableCell>
                    <TableCell>
                      {row.hiveName
                        ? `${row.hiveName}${row.apiaryName ? ` · ${row.apiaryName}` : ""}`
                        : row.apiaryName ?? "Yard"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.amount} {row.unit}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Batches</h2>
            <p className="text-sm text-muted-foreground">
              Creamed, hot honey, and mead consume honey pounds. Tincture consumes propolis.
            </p>
          </div>
          <AddBatchDialog products={catalog.data?.items ?? []} />
        </div>
        {batches.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No batches recorded yet.</p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Inputs</TableHead>
                  <TableHead className="text-right">Out</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.data.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{formatDate(row.startedAt)}</TableCell>
                    <TableCell>
                      {row.productName}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {kindLabel(row.kind)}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.honeyLbs != null ? `${formatLbs(row.honeyLbs)} honey` : ""}
                      {row.harvestLotCode ? ` · ${row.harvestLotCode}` : ""}
                      {row.propolisAmount != null
                        ? `${row.propolisAmount} ${row.propolisUnit ?? "g"} propolis`
                        : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.quantityOut}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function AddProductDialog() {
  const create = useCreateProduct();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<CatalogProductKind>("creamed_honey");
  const [unit, setUnit] = React.useState("jar");
  const [price, setPrice] = React.useState("");
  const [sizeLabel, setSizeLabel] = React.useState("");

  function reset() {
    setName("");
    setKind("creamed_honey");
    setUnit("jar");
    setPrice("");
    setSizeLabel("");
  }

  function submit() {
    const defaultPrice = parseNum(price);
    if (!name.trim() || defaultPrice === null || defaultPrice < 0) return;
    create.mutate(
      {
        name: name.trim(),
        kind,
        unit,
        defaultPrice,
        sizeLabel: sizeLabel.trim() || undefined,
      },
      {
        onSuccess: () => {
          reset();
          setOpen(false);
        },
      },
    );
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus /> Add product
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add catalog product</DialogTitle>
            <DialogDescription>
              A finished SKU. Mead bottles are not jar sizes.
            </DialogDescription>
          </DialogHeader>
          <ShortcutForm
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Kind</Label>
                <Select value={kind} onValueChange={(value) => setKind(value as CatalogProductKind)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRODUCT_KINDS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Unit</Label>
                <Select value={unit} onValueChange={setUnit}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["jar", "bottle", "tin", "each"].map((value) => (
                      <SelectItem key={value} value={value}>{value}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Default price</Label>
                <Input type="number" min="0" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Size (optional)</Label>
                <Input value={sizeLabel} onChange={(event) => setSizeLabel(event.target.value)} placeholder="750ml, 8 oz" />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>Save product</Button>
            </DialogFooter>
          </ShortcutForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AddPropolisDialog() {
  const create = useCreatePropolisHarvest();
  const hives = useHiveOptions();
  const apiaries = useApiaryOptions();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(todayISO());
  const [hiveId, setHiveId] = React.useState("none");
  const [apiaryId, setApiaryId] = React.useState("none");
  const [amount, setAmount] = React.useState("");
  const [unit, setUnit] = React.useState<"grams" | "ounces">("grams");
  const [notes, setNotes] = React.useState("");

  function submit() {
    const parsed = parseNum(amount);
    if (parsed === null || parsed <= 0) return;
    if (hiveId === "none" && apiaryId === "none") return;
    create.mutate(
      {
        date,
        hiveId: hiveId === "none" ? undefined : hiveId,
        apiaryId: apiaryId === "none" ? undefined : apiaryId,
        amount: parsed,
        unit,
        notes: notes.trim() || undefined,
      },
      { onSuccess: () => setOpen(false) },
    );
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus /> Record harvest
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record propolis harvest</DialogTitle>
            <DialogDescription>
              Hive or yard, date, and weight. This does not change honey pounds.
            </DialogDescription>
          </DialogHeader>
          <ShortcutForm
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Hive</Label>
                <Select value={hiveId} onValueChange={setHiveId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No specific hive</SelectItem>
                    {(hives.data ?? []).map((hive) => (
                      <SelectItem key={hive.id} value={hive.id}>
                        {hive.positionLabel} · {hive.apiaryName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Yard</Label>
                <Select value={apiaryId} onValueChange={setApiaryId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No yard-only harvest</SelectItem>
                    {(apiaries.data ?? []).map((apiary) => (
                      <SelectItem key={apiary.id} value={apiary.id}>{apiary.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Amount</Label>
                <Input type="number" min="0" step="0.1" value={amount} onChange={(event) => setAmount(event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>Unit</Label>
                <Select value={unit} onValueChange={(value) => setUnit(value as "grams" | "ounces")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="grams">grams</SelectItem>
                    <SelectItem value="ounces">ounces</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Notes</Label>
              <Textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>Save harvest</Button>
            </DialogFooter>
          </ShortcutForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AddBatchDialog({
  products,
}: {
  products: { id: string; name: string; kind: string; sizeLabel: string | null }[];
}) {
  const create = useCreateProductBatch();
  const lots = useHarvestLots();
  const harvests = usePropolisHarvests();
  const expenses = useExpenses();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState("creamed_honey");
  const [productId, setProductId] = React.useState("");
  const [lotId, setLotId] = React.useState("none");
  const [startedAt, setStartedAt] = React.useState(todayISO());
  const [honeyLbs, setHoneyLbs] = React.useState("");
  const [waterLiters, setWaterLiters] = React.useState("");
  const [yeast, setYeast] = React.useState("");
  const [vessel, setVessel] = React.useState("");
  const [propolisHarvestId, setPropolisHarvestId] = React.useState("");
  const [propolisAmount, setPropolisAmount] = React.useState("");
  const [propolisUnit, setPropolisUnit] = React.useState<"grams" | "ounces">("grams");
  const [quantityOut, setQuantityOut] = React.useState("");
  const [expenseId, setExpenseId] = React.useState("none");
  const [notes, setNotes] = React.useState("");

  const matching = products.filter((product) => product.kind === kind);
  const honeyKind = kind === "creamed_honey" || kind === "hot_honey" || kind === "mead";

  React.useEffect(() => {
    if (!matching.some((product) => product.id === productId)) {
      setProductId(matching[0]?.id ?? "");
    }
  }, [kind, matching, productId]);

  function submit() {
    const out = parseNum(quantityOut);
    if (!productId || out === null || out <= 0) return;
    if (honeyKind) {
      const lbs = parseNum(honeyLbs);
      if (lbs === null || lbs <= 0) return;
      if (kind === "creamed_honey" && lotId === "none") return;
    } else {
      const grams = parseNum(propolisAmount);
      if (!propolisHarvestId || grams === null || grams <= 0) return;
    }
    create.mutate(
      {
        kind,
        productId,
        harvestLotId: lotId === "none" ? undefined : lotId,
        startedAt,
        honeyLbs: honeyKind ? parseNum(honeyLbs) ?? undefined : undefined,
        waterLiters: kind === "mead" ? parseNum(waterLiters) ?? undefined : undefined,
        yeast: kind === "mead" ? yeast.trim() || undefined : undefined,
        vessel: kind === "mead" ? vessel.trim() || undefined : undefined,
        propolisHarvestId: kind === "tincture" ? propolisHarvestId : undefined,
        propolisAmount: kind === "tincture" ? parseNum(propolisAmount) ?? undefined : undefined,
        propolisUnit: kind === "tincture" ? propolisUnit : undefined,
        quantityOut: out,
        notes: notes.trim() || undefined,
        expenseIds: expenseId === "none" ? undefined : [expenseId],
      },
      { onSuccess: () => setOpen(false) },
    );
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus /> Record batch
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a batch</DialogTitle>
            <DialogDescription>
              Honey-consuming batches write a bulk-use movement so the ledger still
              answers where those pounds went.
            </DialogDescription>
          </DialogHeader>
          <ShortcutForm
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Kind</Label>
                <Select value={kind} onValueChange={setKind}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BATCH_KINDS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Product</Label>
                <Select value={productId} onValueChange={setProductId}>
                  <SelectTrigger><SelectValue placeholder="Choose SKU" /></SelectTrigger>
                  <SelectContent>
                    {matching.map((product) => (
                      <SelectItem key={product.id} value={product.id}>
                        {product.sizeLabel ? `${product.name} · ${product.sizeLabel}` : product.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Started</Label>
              <Input type="date" value={startedAt} onChange={(event) => setStartedAt(event.target.value)} />
            </div>
            {honeyKind && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label>Honey lbs</Label>
                    <Input type="number" min="0" step="0.1" value={honeyLbs} onChange={(event) => setHoneyLbs(event.target.value)} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Harvest lot{kind === "creamed_honey" ? "" : " (optional)"}</Label>
                    <Select value={lotId} onValueChange={setLotId}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unassigned</SelectItem>
                        {(lots.data ?? []).map((lot) => (
                          <SelectItem key={lot.id} value={lot.id}>{lot.lotCode}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {kind === "mead" && (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="grid gap-1.5">
                      <Label>Water (L)</Label>
                      <Input type="number" min="0" step="0.1" value={waterLiters} onChange={(event) => setWaterLiters(event.target.value)} />
                    </div>
                    <div className="grid gap-1.5">
                      <Label>Yeast</Label>
                      <Input value={yeast} onChange={(event) => setYeast(event.target.value)} />
                    </div>
                    <div className="grid gap-1.5">
                      <Label>Vessel</Label>
                      <Input value={vessel} onChange={(event) => setVessel(event.target.value)} />
                    </div>
                  </div>
                )}
              </>
            )}
            {kind === "tincture" && (
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-1.5">
                  <Label>Propolis harvest</Label>
                  <Select value={propolisHarvestId} onValueChange={setPropolisHarvestId}>
                    <SelectTrigger><SelectValue placeholder="Harvest" /></SelectTrigger>
                    <SelectContent>
                      {(harvests.data ?? []).map((row) => (
                        <SelectItem key={row.id} value={row.id}>
                          {formatDate(row.date)} · {row.amount} {row.unit}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>Amount used</Label>
                  <Input type="number" min="0" step="0.1" value={propolisAmount} onChange={(event) => setPropolisAmount(event.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label>Unit</Label>
                  <Select value={propolisUnit} onValueChange={(value) => setPropolisUnit(value as "grams" | "ounces")}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="grams">grams</SelectItem>
                      <SelectItem value="ounces">ounces</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {(kind === "hot_honey" || kind === "tincture" || kind === "mead") && (
              <div className="grid gap-1.5">
                <Label>Grocery / ingredient expense</Label>
                <Select value={expenseId} onValueChange={setExpenseId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {(expenses.data ?? []).map((expense) => (
                      <SelectItem key={expense.id} value={expense.id}>
                        {expense.description} · {formatMoney(expense.amount)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label>Quantity out</Label>
              <Input type="number" min="1" value={quantityOut} onChange={(event) => setQuantityOut(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Notes</Label>
              <Textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>Save batch</Button>
            </DialogFooter>
          </ShortcutForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
