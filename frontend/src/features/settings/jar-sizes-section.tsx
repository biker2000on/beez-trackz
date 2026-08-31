"use client";

import * as React from "react";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
} from "@/components/ui/data-grid";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useEquipmentTypes } from "@/features/equipment/hooks";
import { cn } from "@/lib/utils";

import {
  useCreateJarSize,
  useJarSizes,
  useUpdateJarSize,
  type JarSize,
} from "./api";

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberToInput(value: number | null): string {
  return value === null ? "" : String(value);
}

// --- table model ---

/**
 * Sparse per-row edit drafts: a field is stored only once the user has typed
 * in it, so untouched cells always show the server value and a successful
 * save simply drops the row's draft to re-sync with the round-tripped row.
 */
interface JarDraft {
  label?: string;
  honeyOz?: string;
  price?: string;
  lowStockThreshold?: string;
}

interface JarDraftValues {
  label: string;
  honeyOz: string;
  price: string;
  lowStockThreshold: string;
}

function jarDraftValues(jar: JarSize, draft: JarDraft | undefined): JarDraftValues {
  return {
    label: draft?.label ?? jar.label,
    honeyOz: draft?.honeyOz ?? numberToInput(jar.honeyOz),
    price: draft?.price ?? numberToInput(jar.defaultPrice),
    lowStockThreshold:
      draft?.lowStockThreshold ?? String(jar.lowStockThreshold),
  };
}

const gridFeatures = tableFeatures({});
const columnHelper = createColumnHelper<typeof gridFeatures, JarSize>();

export function JarSizesSection() {
  const jarSizes = useJarSizes();
  const createJar = useCreateJarSize();
  const updateJar = useUpdateJarSize();
  const { mutateAsync: updateJarAsync } = updateJar;
  const equipmentTypes = useEquipmentTypes();

  const [drafts, setDrafts] = React.useState<Record<string, JarDraft>>({});
  /** Which row's mutation is in flight, so other rows stay enabled. */
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [newLabel, setNewLabel] = React.useState("");
  const [newHoneyOz, setNewHoneyOz] = React.useState("");
  const [newPrice, setNewPrice] = React.useState("");
  const [newLowStockThreshold, setNewLowStockThreshold] = React.useState("6");

  const setDraft = React.useCallback((id: string, patch: JarDraft) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  const saveJar = React.useCallback(
    async (jar: JarSize, values: JarDraftValues) => {
      if (values.label.trim() === "") {
        toast.error("Label is required");
        return;
      }
      setPendingId(jar.id);
      try {
        await updateJarAsync({
          id: jar.id,
          label: values.label.trim(),
          honeyOz: parseNumber(values.honeyOz),
          defaultPrice: parseNumber(values.price),
          lowStockThreshold: Math.max(
            0,
            Math.floor(Number(values.lowStockThreshold) || 0),
          ),
        });
        toast.success(`Saved "${values.label.trim()}"`);
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[jar.id];
          return next;
        });
      } catch (error) {
        toast.error(
          error instanceof ApiError ? error.message : "Could not save jar size",
        );
      } finally {
        setPendingId(null);
      }
    },
    [updateJarAsync],
  );

  /**
   * Linking an empty container makes jarring draw one packaging unit per jar
   * off the equipment ledger. Saved on pick, like the active checkbox — there
   * is no half-typed state to hold back.
   */
  const setPackaging = React.useCallback(
    async (jar: JarSize, packagingTypeId: string | null) => {
      setPendingId(jar.id);
      try {
        await updateJarAsync({ id: jar.id, packagingTypeId });
      } catch (error) {
        toast.error(
          error instanceof ApiError
            ? error.message
            : "Could not link the empty container",
        );
      } finally {
        setPendingId(null);
      }
    },
    [updateJarAsync],
  );

  const toggleActive = React.useCallback(
    async (jar: JarSize, checked: boolean) => {
      setPendingId(jar.id);
      try {
        await updateJarAsync({ id: jar.id, isActive: checked });
      } catch (error) {
        // Deactivating a size with jars still on hand is refused until the
        // remaining stock is explicitly written off as a visible ledger entry.
        if (error instanceof ApiError && error.status === 409 && !checked) {
          const proceed = window.confirm(
            `${error.message}\n\nWrite the remaining jars off and deactivate "${jar.label}"? The write-off is recorded in the honey ledger.`,
          );
          if (proceed) {
            try {
              await updateJarAsync({
                id: jar.id,
                isActive: false,
                writeOffRemaining: true,
                writeOffReason: "Deactivated from settings",
              });
              toast.success(
                `"${jar.label}" deactivated; remaining jars written off`,
              );
            } catch (retryError) {
              toast.error(
                retryError instanceof ApiError
                  ? retryError.message
                  : "Could not update jar size",
              );
            }
          }
          return;
        }
        toast.error(
          error instanceof ApiError
            ? error.message
            : "Could not update jar size",
        );
      } finally {
        setPendingId(null);
      }
    },
    [updateJarAsync],
  );

  const jars = React.useMemo(() => jarSizes.data ?? [], [jarSizes.data]);
  const packagingTypes = React.useMemo(
    () => (equipmentTypes.data ?? []).filter((t) => t.category === "packaging"),
    [equipmentTypes.data],
  );

  const columns = React.useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "label",
          header: "Label",
          cell: ({ row: { original: jar } }) => (
            <DataGridCellAction
              className={cn(!jar.isActive && "opacity-60")}
            >
              <Input
                aria-label={`Label for ${jar.label}`}
                value={jarDraftValues(jar, drafts[jar.id]).label}
                onChange={(e) => setDraft(jar.id, { label: e.target.value })}
              />
            </DataGridCellAction>
          ),
        }),
        columnHelper.display({
          id: "honeyOz",
          header: "Honey (oz)",
          cell: ({ row: { original: jar } }) => (
            <DataGridCellAction
              className={cn(!jar.isActive && "opacity-60")}
            >
              <Input
                aria-label={`Honey ounces for ${jar.label}`}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                className="w-24"
                value={jarDraftValues(jar, drafts[jar.id]).honeyOz}
                onChange={(e) => setDraft(jar.id, { honeyOz: e.target.value })}
              />
            </DataGridCellAction>
          ),
        }),
        columnHelper.display({
          id: "price",
          header: "Default price ($)",
          cell: ({ row: { original: jar } }) => (
            <DataGridCellAction
              className={cn(!jar.isActive && "opacity-60")}
            >
              <Input
                aria-label={`Default price for ${jar.label}`}
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                className="w-24"
                value={jarDraftValues(jar, drafts[jar.id]).price}
                onChange={(e) => setDraft(jar.id, { price: e.target.value })}
              />
            </DataGridCellAction>
          ),
        }),
        columnHelper.display({
          id: "lowStockThreshold",
          header: "Low-stock alert",
          cell: ({ row: { original: jar } }) => (
            <DataGridCellAction
              className={cn(!jar.isActive && "opacity-60")}
            >
              <Input
                aria-label={`Low stock threshold for ${jar.label}`}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                className="w-24"
                value={jarDraftValues(jar, drafts[jar.id]).lowStockThreshold}
                onChange={(e) =>
                  setDraft(jar.id, { lowStockThreshold: e.target.value })
                }
              />
            </DataGridCellAction>
          ),
        }),
        columnHelper.display({
          id: "packaging",
          header: "Empty containers",
          cell: ({ row: { original: jar } }) => (
            <DataGridCellAction
              className={cn(!jar.isActive && "opacity-60")}
            >
              <Select
                value={jar.packagingTypeId ?? "none"}
                disabled={pendingId === jar.id || packagingTypes.length === 0}
                onValueChange={(value) =>
                  setPackaging(jar, value === "none" ? null : value)
                }
              >
                <SelectTrigger
                  className="w-48"
                  aria-label={`Empty container for ${jar.label}`}
                >
                  <SelectValue placeholder="Not linked" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not linked</SelectItem>
                  {packagingTypes.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DataGridCellAction>
          ),
        }),
        columnHelper.display({
          id: "active",
          header: "Active",
          meta: {
            headClassName: "text-center",
            cellClassName: "text-center",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: jar } }) => (
            <DataGridCellAction
              className={cn(
                "flex justify-center",
                !jar.isActive && "opacity-60",
              )}
            >
              <Checkbox
                aria-label={`${jar.label} active`}
                checked={jar.isActive}
                disabled={pendingId === jar.id}
                onCheckedChange={(checked) =>
                  toggleActive(jar, checked === true)
                }
              />
            </DataGridCellAction>
          ),
        }),
        columnHelper.display({
          id: "save",
          header: "",
          meta: {
            headClassName: "w-12",
            cellClassName: "p-1 text-right",
          } satisfies DataGridColumnMeta,
          cell: ({ row: { original: jar } }) => {
            const values = jarDraftValues(jar, drafts[jar.id]);
            const dirty =
              values.label.trim() !== jar.label ||
              parseNumber(values.honeyOz) !== jar.honeyOz ||
              parseNumber(values.price) !== jar.defaultPrice ||
              Number(values.lowStockThreshold) !== jar.lowStockThreshold;
            return (
              <DataGridCellAction
                className={cn(
                  "flex justify-end",
                  !jar.isActive && "opacity-60",
                )}
              >
                <Button
                  size="icon-sm"
                  variant={dirty ? "default" : "ghost"}
                  aria-label={`Save ${jar.label}`}
                  disabled={!dirty || pendingId === jar.id}
                  onClick={() => saveJar(jar, values)}
                >
                  <Check />
                </Button>
              </DataGridCellAction>
            );
          },
        }),
      ]),
    [drafts, packagingTypes, pendingId, saveJar, setDraft, setPackaging, toggleActive],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data: jars,
    getRowId: (row) => row.id,
  });

  async function handleAdd() {
    if (newLabel.trim() === "") {
      toast.error("Label is required");
      return;
    }
    try {
      await createJar.mutateAsync({
        label: newLabel.trim(),
        honeyOz: parseNumber(newHoneyOz),
        defaultPrice: parseNumber(newPrice),
        lowStockThreshold: Math.max(0, Math.floor(Number(newLowStockThreshold) || 0)),
      });
      toast.success(`Added "${newLabel.trim()}"`);
      setNewLabel("");
      setNewHoneyOz("");
      setNewPrice("");
      setNewLowStockThreshold("6");
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not add jar size",
      );
    }
  }

  if (jarSizes.isLoading) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (jarSizes.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load jar sizes.{" "}
        <button
          type="button"
          className="font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => jarSizes.refetch()}
        >
          Try again
        </button>
      </p>
    );
  }

  const isEmpty = jars.length === 0;

  return (
    <div className="grid gap-3">
      {isEmpty ? (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          No jar sizes yet. These are the containers the honey ledger sells and
          counts stock in — add your first one in the row below.
        </p>
      ) : null}
      <DataGrid
        table={table}
        aria-label="Jar sizes"
        listenOnWindow={false}
        trailingRows={
          <tr>
            <td className="whitespace-nowrap p-3 align-middle">
              <Input
                aria-label="New jar size label"
                placeholder="New size…"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </td>
            <td className="whitespace-nowrap p-3 align-middle">
              <Input
                aria-label="New jar size honey ounces"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                className="w-24"
                placeholder="oz"
                value={newHoneyOz}
                onChange={(e) => setNewHoneyOz(e.target.value)}
              />
            </td>
            <td className="whitespace-nowrap p-3 align-middle">
              <Input
                aria-label="New jar size default price"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                className="w-24"
                placeholder="$"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
              />
            </td>
            <td className="whitespace-nowrap p-3 align-middle">
              <Input
                aria-label="New jar size low stock threshold"
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                className="w-24"
                placeholder="6"
                value={newLowStockThreshold}
                onChange={(e) => setNewLowStockThreshold(e.target.value)}
              />
            </td>
            <td className="whitespace-nowrap p-3 align-middle" />
            <td className="whitespace-nowrap p-3 align-middle" />
            <td className="whitespace-nowrap p-1 text-right align-middle">
              <Button
                size="icon-sm"
                aria-label="Add jar size"
                disabled={createJar.isPending || newLabel.trim() === ""}
                onClick={handleAdd}
              >
                <Plus />
              </Button>
            </td>
          </tr>
        }
      />
      {packagingTypes.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          To draw empty jars, lids, and labels down as you bottle, add an
          equipment type in the <strong>Packaging</strong> category first, then
          link it here.
        </p>
      ) : null}
    </div>
  );
}
