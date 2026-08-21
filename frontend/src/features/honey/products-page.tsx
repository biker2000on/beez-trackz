"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import { GRAMS_PER_OUNCE, parsePropolisMassInput } from "@/lib/units";
import { useUnits } from "@/lib/use-units";

import { formatDate, formatMoney, parseHoneyWeight, parseNum, todayISO } from "./format";
import {
  useAdjustProduct,
  useApiaryOptions,
  useCreateProduct,
  useCreateProductBatch,
  useCreatePropolisHarvest,
  useHiveOptions,
  useProductBatches,
  useProductCatalog,
  usePropolisHarvests,
  useVoidProductBatch,
} from "./hooks";
import type { CatalogProduct, CatalogProductKind, ProductBatch } from "./types";

const PRODUCT_KINDS: { value: CatalogProductKind; label: string }[] = [
  { value: "creamed_honey", label: "Creamed honey" },
  { value: "hot_honey", label: "Hot honey" },
  { value: "mead", label: "Mead" },
  { value: "propolis", label: "Propolis" },
  { value: "tincture", label: "Tincture" },
];

const BATCH_KINDS = PRODUCT_KINDS.filter((kind) => kind.value !== "propolis");

/** Raw propolis is sold off the harvest ledger: whole units that fit in grams on hand. */
function propolisUnitsLeft(gramsOnHand: number, netGrams: number) {
  if (netGrams <= 0) return 0;
  return Math.max(0, Math.floor((gramsOnHand + 1e-9) / netGrams));
}

function kindLabel(kind: string) {
  return PRODUCT_KINDS.find((item) => item.value === kind)?.label ?? kind.replaceAll("_", " ");
}

export function HiveProductsPage() {
  const { formatHoney, formatPropolis } = useUnits();
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
                  <TableHead className="text-right">Net mass</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalog.data?.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="capitalize">{kindLabel(item.kind)}</TableCell>
                    <TableCell>{item.sizeLabel ?? item.unit}</TableCell>
                    <TableCell className="text-right tabular-nums">{item.netGrams != null ? formatPropolis(item.netGrams) : "—"}</TableCell>
                    <TableCell>{formatMoney(item.defaultPrice)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.kind === "propolis" && item.netGrams
                        ? propolisUnitsLeft(catalog.data?.propolisOnHandGrams ?? 0, item.netGrams)
                        : item.onHand}
                      {item.adjusted !== 0 && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({item.adjusted > 0 ? "+" : ""}
                          {item.adjusted} adj)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {item.kind !== "propolis" && <AdjustProductDialog product={item} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {(catalog.data?.propolisOnHandGrams ?? 0) > 0 && (
          <p className="text-sm text-muted-foreground">
            Raw propolis on hand: {formatPropolis(catalog.data?.propolisOnHandGrams)}
            (does not change honey stock).
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
                      {formatPropolis(
                        row.unit === "ounces" ? row.amount * GRAMS_PER_OUNCE : row.amount,
                      )}
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
              Cost is the linked ingredient expenses plus the honey those pounds cost to make.
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
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.data.map((row) => (
                  <TableRow key={row.id} className={row.voidedAt ? "opacity-60" : undefined}>
                    <TableCell>{formatDate(row.startedAt)}</TableCell>
                    <TableCell>
                      {row.productName}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {kindLabel(row.kind)}
                      </span>
                      {row.voidedAt && (
                        <Badge variant="outline" className="ml-2">
                          voided
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.honeyLbs != null ? `${formatHoney(row.honeyLbs)} honey` : ""}
                      {row.harvestLotCode ? ` · ${row.harvestLotCode}` : ""}
                      {row.propolisAmount != null
                        ? ` · ${formatPropolis(
                            row.propolisUnit === "ounces"
                              ? row.propolisAmount * GRAMS_PER_OUNCE
                              : row.propolisAmount,
                          )} propolis`
                        : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.quantityOut}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.totalCost > 0 ? (
                        <>
                          {formatMoney(row.totalCost)}
                          <span className="ml-1 block text-xs text-muted-foreground">
                            {formatMoney(row.costPerUnit)}/unit
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!row.voidedAt && <VoidBatchButton batch={row} />}
                    </TableCell>
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
  const { units, propolisSuffix } = useUnits();
  const create = useCreateProduct();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<CatalogProductKind>("creamed_honey");
  const [unit, setUnit] = React.useState("jar");
  const [price, setPrice] = React.useState("");
  const [sizeLabel, setSizeLabel] = React.useState("");
  const [netGrams, setNetGrams] = React.useState("");
  const showNetGrams = kind === "propolis" || kind === "tincture";
  const parsedNetGrams = parsePropolisMassInput(netGrams, units);
  const netGramsInvalid =
    showNetGrams &&
    (kind === "propolis"
      ? parsedNetGrams === null || parsedNetGrams <= 0
      : netGrams.trim() !== "" && (parsedNetGrams === null || parsedNetGrams <= 0));

  function reset() {
    setName("");
    setKind("creamed_honey");
    setUnit("jar");
    setPrice("");
    setSizeLabel("");
    setNetGrams("");
  }

  function submit() {
    const defaultPrice = parseNum(price);
    if (!name.trim() || defaultPrice === null || defaultPrice < 0) return;
    if (netGramsInvalid) return;
    create.mutate(
      {
        name: name.trim(),
        kind,
        unit,
        defaultPrice,
        sizeLabel: sizeLabel.trim() || undefined,
        netGrams: showNetGrams && parsedNetGrams !== null && parsedNetGrams > 0 ? parsedNetGrams : undefined,
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
            {showNetGrams && (
              <div className="grid gap-1.5">
                <Label>Net mass {kind === "propolis" ? "" : "(optional)"} ({propolisSuffix})</Label>
                <Input
                  inputMode="decimal"
                  required={kind === "propolis"}
                  value={netGrams}
                  onChange={(event) => setNetGrams(event.target.value)}
                  placeholder={`e.g. 10 ${propolisSuffix}`}
                  aria-invalid={netGramsInvalid || undefined}
                />
                <p className="text-xs text-muted-foreground">
                  {kind === "propolis"
                    ? "Raw propolis per unit sold; each sale takes this much off propolis on hand. Suffixes like 2 oz are accepted."
                    : "Propolis per bottle, for reference. Suffixes like 2 oz are accepted."}
                </p>
              </div>
            )}
            <DialogFooter>
              <Button type="submit" disabled={create.isPending || netGramsInvalid}>Save product</Button>
            </DialogFooter>
          </ShortcutForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AddPropolisDialog() {
  const { units, propolisSuffix } = useUnits();
  const create = useCreatePropolisHarvest();
  const hives = useHiveOptions();
  const apiaries = useApiaryOptions();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(todayISO());
  const [hiveId, setHiveId] = React.useState("none");
  const [apiaryId, setApiaryId] = React.useState("none");
  const [amount, setAmount] = React.useState("");
  const [notes, setNotes] = React.useState("");

  function submit() {
    const grams = parsePropolisMassInput(amount, units);
    if (grams === null || grams <= 0) return;
    if (hiveId === "none" && apiaryId === "none") return;
    create.mutate(
      {
        date,
        hiveId: hiveId === "none" ? undefined : hiveId,
        apiaryId: apiaryId === "none" ? undefined : apiaryId,
        amount: grams,
        unit: "grams",
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
            <div className="grid gap-1.5">
              <Label>Amount ({propolisSuffix})</Label>
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder={`e.g. 10 ${propolisSuffix} or 0.5 oz`}
              />
              <p className="text-xs text-muted-foreground">
                Stored in grams. Type a suffix to override the preferred unit.
              </p>
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
  const { units, honeySuffix, propolisSuffix, formatPropolis } = useUnits();
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
  const [quantityOut, setQuantityOut] = React.useState("");
  const [expenseId, setExpenseId] = React.useState("none");
  const [notes, setNotes] = React.useState("");

  const matching = products.filter((product) => product.kind === kind);
  const honeyKind = kind === "creamed_honey" || kind === "hot_honey" || kind === "mead";
  const selectedProductId = matching.some((product) => product.id === productId)
    ? productId
    : (matching[0]?.id ?? "");

  function submit() {
    const out = parseNum(quantityOut);
    if (!selectedProductId || out === null || out <= 0) return;
    if (honeyKind) {
      const lbs = parseHoneyWeight(honeyLbs, units);
      if (lbs === null || lbs <= 0) return;
      if (kind === "creamed_honey" && lotId === "none") return;
    } else {
      const grams = parsePropolisMassInput(propolisAmount, units);
      if (!propolisHarvestId || grams === null || grams <= 0) return;
    }
    create.mutate(
      {
        kind,
        productId: selectedProductId,
        harvestLotId: lotId === "none" ? undefined : lotId,
        startedAt,
        honeyLbs: honeyKind ? parseHoneyWeight(honeyLbs, units) ?? undefined : undefined,
        waterLiters: kind === "mead" ? parseNum(waterLiters) ?? undefined : undefined,
        yeast: kind === "mead" ? yeast.trim() || undefined : undefined,
        vessel: kind === "mead" ? vessel.trim() || undefined : undefined,
        propolisHarvestId: kind === "tincture" ? propolisHarvestId : undefined,
        propolisAmount: kind === "tincture" ? parsePropolisMassInput(propolisAmount, units) ?? undefined : undefined,
        propolisUnit: kind === "tincture" ? "grams" : undefined,
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
                <Select value={selectedProductId} onValueChange={setProductId}>
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
                    <Label>Honey ({honeySuffix})</Label>
                    <Input
                      inputMode="decimal"
                      value={honeyLbs}
                      onChange={(event) => setHoneyLbs(event.target.value)}
                      placeholder={`e.g. 2 kg or 4.4 ${honeySuffix}`}
                    />
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
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Propolis harvest</Label>
                  <Select value={propolisHarvestId} onValueChange={setPropolisHarvestId}>
                    <SelectTrigger><SelectValue placeholder="Harvest" /></SelectTrigger>
                    <SelectContent>
                      {(harvests.data ?? []).map((row) => (
                        <SelectItem key={row.id} value={row.id}>
                          {formatDate(row.date)} · {formatPropolis(
                            row.unit === "ounces" ? row.amount * GRAMS_PER_OUNCE : row.amount,
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5 col-span-2">
                  <Label>Amount used ({propolisSuffix})</Label>
                  <Input
                    inputMode="decimal"
                    value={propolisAmount}
                    onChange={(event) => setPropolisAmount(event.target.value)}
                    placeholder={`e.g. 10 ${propolisSuffix}`}
                  />
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

/**
 * Undo a wrong batch. A void is not a delete: the honey the batch consumed
 * comes back as a reversing movement and the output stops counting, so the
 * ledger still says what happened. It is refused once the output has been sold
 * or consigned, which the error message explains inline.
 */
function VoidBatchButton({ batch }: { batch: ProductBatch }) {
  const { formatHoney } = useUnits();
  const voidBatch = useVoidProductBatch();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Void
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void this batch?</AlertDialogTitle>
            <AlertDialogDescription>
              {`${batch.quantityOut} ${batch.productName} stop counting as on hand` +
                (batch.honeyLbs != null
                  ? `, and the ${formatHoney(batch.honeyLbs)} it consumed goes back to bulk honey`
                  : batch.propolisAmount != null
                    ? ", and the propolis it consumed goes back on hand"
                    : "") +
                ". The batch stays in the list, marked voided."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep batch</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                setError(null);
                voidBatch.mutate(
                  { id: batch.id },
                  {
                    onSuccess: () => setOpen(false),
                    onError: (cause) =>
                      setError(cause instanceof Error ? cause.message : "Void failed"),
                  },
                );
              }}
              disabled={voidBatch.isPending}
            >
              Void batch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Record shrink or found stock on a catalog SKU — the ledger jars have always
 * had. A negative delta cannot drive the SKU below what is standing at home.
 */
function AdjustProductDialog({ product }: { product: CatalogProduct }) {
  const adjust = useAdjustProduct();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(todayISO());
  const [delta, setDelta] = React.useState("-1");
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  // One key per dialog session: a double-click or retried request lands on the
  // same key and the API refuses the duplicate instead of shrinking twice.
  const [idempotencyKey, setIdempotencyKey] = React.useState(() =>
    crypto.randomUUID(),
  );

  const parsedDelta = parseNum(delta);
  const invalid = parsedDelta === null || !Number.isInteger(parsedDelta) || parsedDelta === 0;

  function submit() {
    if (invalid) return;
    setError(null);
    adjust.mutate(
      {
        productId: product.id,
        date,
        delta: parsedDelta,
        reason: reason.trim() || undefined,
        idempotencyKey,
      },
      {
        onSuccess: () => {
          setDelta("-1");
          setReason("");
          setOpen(false);
          setIdempotencyKey(crypto.randomUUID());
        },
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : "Adjustment failed"),
      },
    );
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Adjust
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust {product.name}</DialogTitle>
            <DialogDescription>
              A signed count: −1 for a bottle that broke, +1 for one found. Shrink at a
              consignment shop is recorded by their report instead.
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
                <Label htmlFor="adjust-date">Date</Label>
                <Input
                  id="adjust-date"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="adjust-delta">Change</Label>
                <Input
                  id="adjust-delta"
                  type="number"
                  step="1"
                  value={delta}
                  onChange={(event) => setDelta(event.target.value)}
                  aria-invalid={invalid || undefined}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="adjust-reason">Reason</Label>
              <Input
                id="adjust-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="broke in the crate"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={adjust.isPending || invalid}>
                Save adjustment
              </Button>
            </DialogFooter>
          </ShortcutForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
