"use client";

/**
 * Back-office reports for the honey business. These used to be four nested
 * tabs inside `/harvest` → Business; they are now sections of `/reports`, the
 * single home for financial numbers.
 *
 * Revenue here is *invoiced* (order totals, unpaid orders included) because
 * that is what `/analytics/profitability` sums. Collected figures live on the
 * sales list and the market-day reconciliation.
 */

import * as React from "react";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Bell, DollarSign, Plus, Trash2, Users } from "lucide-react";

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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
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
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
} from "@/components/ui/data-grid";
import { Textarea } from "@/components/ui/textarea";
import { useApiaryOptions, useHiveOptions, useJarInventory } from "@/features/honey/hooks";
import { formatDate, formatLbs, formatMoney, todayISO } from "@/features/honey/format";
import {
  useCreateCustomer,
  useCreateExpense,
  useCreateWholesalePriceList,
  useCustomers,
  useDeleteExpense,
  useExpenses,
  useHarvestLots,
  useProductionPlan,
  useProfitability,
  useUpdateCustomer,
  useWholesalePriceLists,
  type Customer,
  type Expense,
  type ProductionPlan,
  type Profitability,
} from "./api";

// --- grid plumbing ---------------------------------------------------------

const gridFeatures = tableFeatures({});

const rightAligned: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

type BreakEvenRow = Profitability["breakEvenByJarSize"][number];
type ChannelRow = Profitability["byChannel"][number];
type KindRow = NonNullable<Profitability["byKind"]>[number];
type SeasonRow = Profitability["bySeason"][number];
type HarvestLotRow = Profitability["byHarvestLot"][number];
type JarPerformanceRow = Profitability["byJarSize"][number];
type PlanRow = ProductionPlan["recommendations"][number];

const breakEvenHelper = createColumnHelper<typeof gridFeatures, BreakEvenRow>();
const breakEvenColumns = breakEvenHelper.columns([
  breakEvenHelper.display({
    id: "label",
    header: "Size",
    cell: ({ row }) => row.original.label,
  }),
  breakEvenHelper.display({
    id: "breakEven",
    header: "Break even",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.breakEvenPrice),
  }),
  breakEvenHelper.display({
    id: "price",
    header: "Price",
    meta: rightAligned,
    cell: ({ row }) =>
      row.original.defaultPrice == null
        ? "—"
        : formatMoney(row.original.defaultPrice),
  }),
]);

function BreakEvenTable({ rows }: { rows: BreakEvenRow[] }) {
  const data = React.useMemo(() => rows, [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: breakEvenColumns,
    data,
    getRowId: (row) => row.jarSizeId,
  });
  return (
    <DataGrid table={table} aria-label="Break-even prices" listenOnWindow={false} />
  );
}

const channelHelper = createColumnHelper<typeof gridFeatures, ChannelRow>();
const channelColumns = channelHelper.columns([
  channelHelper.display({
    id: "channel",
    header: "Channel",
    meta: { cellClassName: "capitalize" } satisfies DataGridColumnMeta,
    cell: ({ row }) => row.original.channel.replaceAll("_", " "),
  }),
  channelHelper.display({
    id: "orders",
    header: "Orders",
    meta: rightAligned,
    cell: ({ row }) => row.original.orderCount,
  }),
  channelHelper.display({
    id: "revenue",
    header: "Revenue (invoiced)",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.revenue),
  }),
]);

function ChannelTable({ rows }: { rows: ChannelRow[] }) {
  const data = React.useMemo(() => rows, [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: channelColumns,
    data,
    getRowId: (row) => row.channel,
  });
  return (
    <DataGrid table={table} aria-label="Revenue by channel" listenOnWindow={false} />
  );
}

const kindHelper = createColumnHelper<typeof gridFeatures, KindRow>();
const kindColumns = kindHelper.columns([
  kindHelper.display({
    id: "kind",
    header: "Kind",
    cell: ({ row }) => (
      <>
        <span className="capitalize">{row.original.kind}</span>
        {row.original.costedLines < row.original.totalLines && (
          <p className="text-xs text-muted-foreground">
            Cost known for {row.original.costedLines} of {row.original.totalLines} lines
          </p>
        )}
      </>
    ),
  }),
  kindHelper.display({
    id: "revenue",
    header: "Revenue",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.revenue),
  }),
  kindHelper.display({
    id: "cost",
    header: "Cost",
    meta: rightAligned,
    cell: ({ row }) =>
      row.original.cost == null ? "—" : formatMoney(row.original.cost),
  }),
  kindHelper.display({
    id: "margin",
    header: "Margin",
    meta: rightAligned,
    cell: ({ row }) =>
      row.original.margin == null ? "—" : formatMoney(row.original.margin),
  }),
]);

function KindTable({ rows }: { rows: KindRow[] }) {
  const data = React.useMemo(() => rows, [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: kindColumns,
    data,
    getRowId: (row) => row.kind,
  });
  return (
    <DataGrid table={table} aria-label="Revenue by kind" listenOnWindow={false} />
  );
}

const seasonHelper = createColumnHelper<typeof gridFeatures, SeasonRow>();
const seasonColumns = seasonHelper.columns([
  seasonHelper.display({
    id: "season",
    header: "Season",
    cell: ({ row }) => row.original.season,
  }),
  seasonHelper.display({
    id: "revenue",
    header: "Revenue",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.revenue),
  }),
  seasonHelper.display({
    id: "margin",
    header: "Margin",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.margin),
  }),
]);

function SeasonTable({ rows }: { rows: SeasonRow[] }) {
  const data = React.useMemo(() => rows, [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: seasonColumns,
    data,
    getRowId: (row) => row.season,
  });
  return (
    <DataGrid table={table} aria-label="Season economics" listenOnWindow={false} />
  );
}

const harvestLotHelper = createColumnHelper<typeof gridFeatures, HarvestLotRow>();
const harvestLotColumns = harvestLotHelper.columns([
  harvestLotHelper.display({
    id: "lot",
    header: "Lot",
    cell: ({ row }) => (
      <>
        <p className="font-medium">{row.original.lotCode}</p>
        <p className="text-xs text-muted-foreground">
          {row.original.season ?? "No season"}
        </p>
      </>
    ),
  }),
  harvestLotHelper.display({
    id: "revenue",
    header: "Revenue",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.revenue),
  }),
  harvestLotHelper.display({
    id: "margin",
    header: "Margin",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.margin),
  }),
]);

function HarvestLotTable({ rows }: { rows: HarvestLotRow[] }) {
  const data = React.useMemo(() => rows, [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: harvestLotColumns,
    data,
    getRowId: (row) => row.harvestLotId,
  });
  return (
    <DataGrid table={table} aria-label="Harvest lots" listenOnWindow={false} />
  );
}

const jarPerformanceHelper = createColumnHelper<
  typeof gridFeatures,
  JarPerformanceRow
>();
const jarPerformanceColumns = jarPerformanceHelper.columns([
  jarPerformanceHelper.display({
    id: "label",
    header: "Size",
    cell: ({ row }) => row.original.label,
  }),
  jarPerformanceHelper.display({
    id: "sold",
    header: "Sold",
    meta: rightAligned,
    cell: ({ row }) => row.original.jarsSold,
  }),
  jarPerformanceHelper.display({
    id: "margin",
    header: "Margin",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.estimatedMargin),
  }),
]);

function JarPerformanceTable({ rows }: { rows: JarPerformanceRow[] }) {
  const data = React.useMemo(() => rows, [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: jarPerformanceColumns,
    data,
    getRowId: (row) => row.jarSizeId,
  });
  return (
    <DataGrid table={table} aria-label="Jar-size performance" listenOnWindow={false} />
  );
}

export function ProfitabilityPanel({ year }: { year: number }) {
  const report = useProfitability(year);
  if (report.isPending) return <Skeleton className="h-64" />;
  if (report.isError) return <ErrorText />;
  const data = report.data;
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Revenue (invoiced)" value={formatMoney(data.revenue)} detail="Order totals, unpaid orders included" />
        <Metric label="Expenses" value={formatMoney(data.expenses)} />
        <Metric label="Gross margin" value={formatMoney(data.grossMargin)} detail={`${data.marginPercent.toFixed(0)}%`} />
        <Metric label="Inventory value" value={formatMoney(data.inventoryValue)} />
        <Metric label="Cost / harvested lb" value={formatMoney(data.costPerHarvestedPound)} />
        <Metric label="Cost / jar sold" value={formatMoney(data.costPerJarSold)} />
        <Metric label="Harvested" value={formatLbs(data.harvestedPounds)} />
        <Metric label="Jars sold" value={String(data.jarsSold)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle className="text-base">Break-even prices</CardTitle></CardHeader><CardContent className="p-0"><BreakEvenTable rows={data.breakEvenByJarSize} /></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Revenue by channel</CardTitle></CardHeader><CardContent className="p-0"><ChannelTable rows={data.byChannel} /></CardContent></Card>
        {(data.byKind?.length ?? 0) > 0 && (
          <Card><CardHeader><CardTitle className="text-base">Revenue by kind</CardTitle></CardHeader><CardContent className="p-0"><KindTable rows={data.byKind!} /></CardContent></Card>
        )}
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-base">Season economics</CardTitle></CardHeader>
          <CardContent className="p-0">
            <SeasonTable rows={data.bySeason} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Harvest lots</CardTitle></CardHeader>
          <CardContent className="p-0">
            <HarvestLotTable rows={data.byHarvestLot} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Jar-size performance</CardTitle></CardHeader>
          <CardContent className="p-0">
            <JarPerformanceTable rows={data.byJarSize} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function ExpensesPanel({ year }: { year: number }) {
  const expenses = useExpenses(year);
  const remove = useDeleteExpense();
  const [open, setOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState<Expense | null>(null);
  if (expenses.isPending) return <Skeleton className="h-64" />;
  if (expenses.isError) return <ErrorText />;
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{formatMoney(expenses.data.reduce((sum, row) => sum + row.amount, 0))} recorded in {year}</p>
        <Button size="sm" onClick={() => setOpen(true)}><Plus /> Add expense</Button>
      </div>
      <Card><CardContent className="overflow-x-auto p-0"><ExpensesTable rows={expenses.data} onDelete={setConfirmDelete} /></CardContent></Card>
      <ExpenseDialog open={open} onOpenChange={setOpen} />
      <AlertDialog open={confirmDelete !== null} onOpenChange={(next) => { if (!next) setConfirmDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this expense?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete
                ? `${formatMoney(confirmDelete.amount)} — ${confirmDelete.description} (${formatDate(confirmDelete.expenseDate)}) is removed permanently and stops counting against profitability.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep expense</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                if (confirmDelete) remove.mutate(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              Delete expense
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const expenseHelper = createColumnHelper<typeof gridFeatures, Expense>();

function ExpensesTable({
  rows,
  onDelete,
}: {
  rows: Expense[];
  onDelete: (expense: Expense) => void;
}) {
  const data = React.useMemo(() => rows, [rows]);
  const columns = React.useMemo(
    () =>
      expenseHelper.columns([
        expenseHelper.display({
          id: "date",
          header: "Date",
          cell: ({ row }) => formatDate(row.original.expenseDate),
        }),
        expenseHelper.display({
          id: "category",
          header: "Category",
          meta: { cellClassName: "capitalize" } satisfies DataGridColumnMeta,
          cell: ({ row }) => row.original.category.replaceAll("_", " "),
        }),
        expenseHelper.display({
          id: "description",
          header: "Description",
          cell: ({ row }) => row.original.description,
        }),
        expenseHelper.display({
          id: "assignedTo",
          header: "Assigned to",
          cell: ({ row }) =>
            row.original.lotCode ??
            row.original.hiveName ??
            row.original.apiaryName ??
            row.original.season ??
            "General",
        }),
        expenseHelper.display({
          id: "amount",
          header: "Amount",
          meta: {
            align: "right",
            cellClassName: "font-medium tabular-nums",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) => formatMoney(row.original.amount),
        }),
        expenseHelper.display({
          id: "actions",
          header: "",
          meta: { cellClassName: "p-1 text-right" } satisfies DataGridColumnMeta,
          cell: ({ row }) => (
            <DataGridCellAction className="flex justify-end">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete expense"
                onClick={() => onDelete(row.original)}
              >
                <Trash2 />
              </Button>
            </DataGridCellAction>
          ),
        }),
      ]),
    [onDelete],
  );
  const table = useTable({
    features: gridFeatures,
    columns,
    data,
    getRowId: (row) => row.id,
  });
  return (
    <DataGrid
      table={table}
      aria-label="Expenses"
      onRowDelete={(row) => onDelete(row)}
    />
  );
}

const EXPENSE_CATEGORIES = ["bees_queens", "feed", "treatments", "packaging", "equipment", "mileage", "market_fees", "labor", "other", "grocery"];

function ExpenseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const create = useCreateExpense();
  const apiaries = useApiaryOptions();
  const hives = useHiveOptions();
  const lots = useHarvestLots();
  const [date, setDate] = React.useState(todayISO());
  const [category, setCategory] = React.useState("feed");
  const [description, setDescription] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [assignment, setAssignment] = React.useState("general");
  const [vendor, setVendor] = React.useState("");
  const [notes, setNotes] = React.useState("");
  function resetDraft() {
    setDate(todayISO());
    setCategory("feed");
    setDescription("");
    setAmount("");
    setAssignment("general");
    setVendor("");
    setNotes("");
  }
  function save(resetAfter = false) {
    const value = Number(amount);
    if (!description.trim() || !Number.isFinite(value) || value < 0) return;
    const [kind, id] = assignment.split(":");
    create.mutate({
      expenseDate: date, category, description: description.trim(), amount: value,
      apiaryId: kind === "apiary" ? id : undefined,
      hiveId: kind === "hive" ? id : undefined,
      harvestLotId: kind === "lot" ? id : undefined,
      vendor: vendor.trim() || undefined, notes: notes.trim() || undefined,
    }, {
      onSuccess: () => {
        if (resetAfter) resetDraft();
        else onOpenChange(false);
      },
    });
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Add expense</DialogTitle></DialogHeader>
      <ShortcutForm className="grid gap-4" onSubmit={(event) => { event.preventDefault(); save(); }} onSubmitAndReset={() => save(true)} onEscape={() => onOpenChange(false)}>
        <div className="grid grid-cols-2 gap-3"><div className="grid gap-1.5"><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div><div className="grid gap-1.5"><Label>Category</Label><Select value={category} onValueChange={setCategory}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{EXPENSE_CATEGORIES.map((value) => <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></div></div>
        <div className="grid gap-1.5"><Label>Description</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3"><div className="grid gap-1.5"><Label>Amount</Label><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div><div className="grid gap-1.5"><Label>Vendor</Label><Input value={vendor} onChange={(e) => setVendor(e.target.value)} /></div></div>
        <div className="grid gap-1.5"><Label>Assign cost</Label><Select value={assignment} onValueChange={setAssignment}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="general">General operation</SelectItem>{(apiaries.data ?? []).map((row) => <SelectItem key={`apiary:${row.id}`} value={`apiary:${row.id}`}>Apiary · {row.name}</SelectItem>)}{(hives.data ?? []).map((row) => <SelectItem key={`hive:${row.id}`} value={`hive:${row.id}`}>Hive · {row.apiaryName} / {row.positionLabel}</SelectItem>)}{(lots.data ?? []).map((row) => <SelectItem key={`lot:${row.id}`} value={`lot:${row.id}`}>Lot · {row.lotCode}</SelectItem>)}</SelectContent></Select></div>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={create.isPending}>{create.isPending ? "Saving…" : "Save expense"}</Button></DialogFooter>
      </ShortcutForm>
    </DialogContent></Dialog>
  );
}

export function PlanningPanel() {
  const plan = useProductionPlan();
  if (plan.isPending) return <Skeleton className="h-64" />;
  if (plan.isError) return <ErrorText />;
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Honey required" value={formatLbs(plan.data.honeyRequiredLbs)} />
        <Metric label="Projected revenue" value={formatMoney(plan.data.projectedRevenue)} />
        <Metric label="Wholesale reserved" value={formatLbs(plan.data.bulkReservedForWholesaleLbs)} />
        <Metric label="Release subscribers" value={String(plan.data.releaseAlertSubscribers)} detail="Opted-in customers" />
      </div>
      {plan.data.bulkAvailableAfterPlanLbs < 0 && <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">This plan needs {formatLbs(Math.abs(plan.data.bulkAvailableAfterPlanLbs))} more bulk honey than is available.</div>}
      <Card><CardContent className="p-0"><PlanTable rows={plan.data.recommendations} /></CardContent></Card>
    </div>
  );
}

// The old table pinned its first column via `Table pinFirstColumn`; the same
// sticky treatment is applied per-column here so a sideways scroll never
// leaves a row without its jar size.
const planPinned = "sticky left-0 z-[1] bg-card";

const planHelper = createColumnHelper<typeof gridFeatures, PlanRow>();
const planColumns = planHelper.columns([
  planHelper.display({
    id: "label",
    header: "Jar size",
    meta: {
      headClassName: planPinned,
      cellClassName: `${planPinned} font-medium`,
    } satisfies DataGridColumnMeta,
    cell: ({ row }) => row.original.label,
  }),
  planHelper.display({
    id: "onHand",
    header: "On hand",
    meta: rightAligned,
    cell: ({ row }) => row.original.onHand,
  }),
  planHelper.display({
    id: "soldInLookback",
    header: "90-day sales",
    meta: rightAligned,
    cell: ({ row }) => row.original.soldInLookback,
  }),
  planHelper.display({
    id: "bottleNext",
    header: "Bottle next",
    meta: {
      align: "right",
      cellClassName: "font-semibold tabular-nums",
    } satisfies DataGridColumnMeta,
    cell: ({ row }) => row.original.recommendedToBottle,
  }),
  planHelper.display({
    id: "packaging",
    header: "Packaging",
    meta: rightAligned,
    cell: ({ row }) => row.original.packagingRequired,
  }),
  planHelper.display({
    id: "honey",
    header: "Honey",
    meta: rightAligned,
    cell: ({ row }) => formatLbs(row.original.honeyRequiredLbs),
  }),
  planHelper.display({
    id: "revenue",
    header: "Revenue",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.projectedRevenue),
  }),
]);

function PlanTable({ rows }: { rows: PlanRow[] }) {
  const data = React.useMemo(() => rows, [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: planColumns,
    data,
    getRowId: (row) => row.jarSizeId,
  });
  return <DataGrid table={table} aria-label="Bottling recommendations" />;
}

export function CustomersPanel() {
  const customers = useCustomers();
  const priceLists = useWholesalePriceLists();
  const [customerOpen, setCustomerOpen] = React.useState(false);
  const [editCustomer, setEditCustomer] = React.useState<Customer | null>(null);
  const [priceOpen, setPriceOpen] = React.useState(false);
  if (customers.isPending || priceLists.isPending) return <Skeleton className="h-64" />;
  if (customers.isError || priceLists.isError) return <ErrorText />;
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" size="sm" onClick={() => setPriceOpen(true)}><DollarSign /> New wholesale list</Button><Button size="sm" onClick={() => setCustomerOpen(true)}><Plus /> Add customer</Button></div>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Users className="size-4" /> Customers</CardTitle></CardHeader><CardContent className="p-0"><CustomersTable rows={customers.data} onEdit={setEditCustomer} /></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Wholesale price lists</CardTitle></CardHeader><CardContent className="grid gap-3">{priceLists.data.length === 0 ? <p className="text-sm text-muted-foreground">No wholesale pricing yet.</p> : priceLists.data.map((list) => <div key={list.id} className="rounded-md border p-3 text-sm"><div className="flex justify-between gap-2"><p className="font-medium">{list.name}</p><span>{formatMoney(list.minimumOrderAmount)} minimum</span></div><p className="mt-1 text-xs text-muted-foreground">{list.items.map((item) => `${item.label} ${formatMoney(item.unitPrice)}`).join(" · ")}</p></div>)}</CardContent></Card>
      </div>
      <CustomerDialog open={customerOpen} onOpenChange={setCustomerOpen} />
      {editCustomer && (
        <CustomerDialog
          open
          onOpenChange={(open) => !open && setEditCustomer(null)}
          customer={editCustomer}
        />
      )}
      <PriceListDialog open={priceOpen} onOpenChange={setPriceOpen} />
    </div>
  );
}

const customerHelper = createColumnHelper<typeof gridFeatures, Customer>();
const customerColumns = customerHelper.columns([
  customerHelper.display({
    id: "name",
    header: "Name",
    cell: ({ row }) => (
      <>
        <p className="font-medium">{row.original.name}</p>
        <p className="text-xs text-muted-foreground">{row.original.referralCode}</p>
      </>
    ),
  }),
  customerHelper.display({
    id: "contact",
    header: "Contact",
    cell: ({ row }) => (
      <>
        <p>{row.original.email ?? row.original.phone ?? "—"}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {row.original.emailOptIn && (
            <Badge variant="accent" className="gap-1">
              <Bell className="size-3" /> Release alerts
            </Badge>
          )}
          {row.original.reorderReminderDue && (
            <Badge variant="secondary">Reorder reminder due</Badge>
          )}
        </div>
      </>
    ),
  }),
  customerHelper.display({
    id: "orders",
    header: "Orders",
    meta: rightAligned,
    cell: ({ row }) => row.original.orderCount,
  }),
  customerHelper.display({
    id: "revenue",
    header: "Revenue",
    meta: rightAligned,
    cell: ({ row }) => formatMoney(row.original.lifetimeRevenue),
  }),
]);

function CustomersTable({
  rows,
  onEdit,
}: {
  rows: Customer[];
  onEdit: (customer: Customer) => void;
}) {
  const data = React.useMemo(() => rows, [rows]);
  const table = useTable({
    features: gridFeatures,
    columns: customerColumns,
    data,
    getRowId: (row) => row.id,
  });
  return (
    <DataGrid
      table={table}
      aria-label="Customers"
      onRowActivate={(row) => onEdit(row)}
    />
  );
}

/** Create a customer, or — when `customer` is set — edit them in place. */
function CustomerDialog({ open, onOpenChange, customer }: { open: boolean; onOpenChange: (open: boolean) => void; customer?: Customer }) {
  const create = useCreateCustomer();
  const update = useUpdateCustomer();
  const busy = create.isPending || update.isPending;
  const [name, setName] = React.useState(customer?.name ?? "");
  const [email, setEmail] = React.useState(customer?.email ?? "");
  const [phone, setPhone] = React.useState(customer?.phone ?? "");
  const [notes, setNotes] = React.useState(customer?.notes ?? "");
  const [optIn, setOptIn] = React.useState(customer?.emailOptIn ?? false);

  function resetDraft() {
    setName("");
    setEmail("");
    setPhone("");
    setNotes("");
    setOptIn(false);
  }

  function submit(resetAfter = false) {
    if (customer) {
      update.mutate({
        id: customer.id,
        name,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        emailOptIn: optIn,
        // Preserve referral wiring; this dialog does not edit it.
        referralCode: customer.referralCode ?? undefined,
        referredBy: customer.referredBy ?? undefined,
      }, { onSuccess: () => onOpenChange(false) });
    } else {
      create.mutate({ name, email: email.trim() || undefined, phone: phone.trim() || undefined, emailOptIn: optIn }, {
        onSuccess: () => {
          if (resetAfter) resetDraft();
          else onOpenChange(false);
        },
      });
    }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{customer ? `Edit ${customer.name}` : "Add customer"}</DialogTitle></DialogHeader><ShortcutForm className="grid gap-3" onSubmit={(event) => { event.preventDefault(); submit(); }} onSubmitAndReset={customer ? undefined : () => submit(true)} onEscape={() => onOpenChange(false)}><div className="grid gap-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div><div className="grid grid-cols-2 gap-3"><div className="grid gap-1.5"><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div><div className="grid gap-1.5"><Label>Phone</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></div></div>{customer && <div className="grid gap-1.5"><Label>Notes</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>}<label className="flex items-center gap-2 text-sm"><Checkbox checked={optIn} onCheckedChange={(value) => setOptIn(value === true)} />Customer opted into seasonal release and reorder emails</label><DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !name.trim()}>{customer ? "Save changes" : "Save customer"}</Button></DialogFooter></ShortcutForm></DialogContent></Dialog>;
}

function PriceListDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const inventory = useJarInventory(); const create = useCreateWholesalePriceList();
  const [name, setName] = React.useState(""); const [minimum, setMinimum] = React.useState("0"); const [prices, setPrices] = React.useState<Record<string, string>>({});
  function submit(resetAfter = false) {
    create.mutate({ name, minimumOrderAmount: Number(minimum), items: Object.entries(prices).filter(([, price]) => price !== "").map(([jarSizeId, price]) => ({ jarSizeId, unitPrice: Number(price) })) }, {
      onSuccess: () => {
        if (resetAfter) {
          setName("");
          setMinimum("0");
          setPrices({});
        } else onOpenChange(false);
      },
    });
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Wholesale price list</DialogTitle></DialogHeader><ShortcutForm className="grid gap-3" onSubmit={(event) => { event.preventDefault(); submit(); }} onSubmitAndReset={() => submit(true)} onEscape={() => onOpenChange(false)}><div className="grid grid-cols-2 gap-3"><div className="grid gap-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="2026 wholesale" /></div><div className="grid gap-1.5"><Label>Minimum order</Label><Input type="number" min="0" step="0.01" value={minimum} onChange={(e) => setMinimum(e.target.value)} /></div></div>{(inventory.data ?? []).map((row) => <div key={row.jarSizeId} className="grid grid-cols-[1fr_120px] items-center gap-3"><Label>{row.label}</Label><Input type="number" min="0" step="0.01" value={prices[row.jarSizeId] ?? ""} onChange={(e) => setPrices((current) => ({ ...current, [row.jarSizeId]: e.target.value }))} placeholder="Price" /></div>)}<DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={create.isPending || !name.trim()}>Save price list</Button></DialogFooter></ShortcutForm></DialogContent></Dialog>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <Card><CardContent className="p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>{detail && <p className="text-xs text-muted-foreground">{detail}</p>}</CardContent></Card>;
}

function ErrorText() { return <p className="py-8 text-center text-sm text-muted-foreground">Could not load business data.</p>; }
