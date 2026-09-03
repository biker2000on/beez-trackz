"use client";

/**
 * Equipment type management: the catalog of types, their varieties, and each
 * type's bill of materials, plus assemble/disassemble actions that move real
 * stock through the ledger.
 */

import * as React from "react";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import {
  CornerDownRight,
  Hammer,
  MoreHorizontal,
  Plus,
  Wrench,
} from "lucide-react";

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
import { Card, CardContent } from "@/components/ui/card";
import {
  DataGrid,
  DataGridCellAction,
  type DataGridColumnMeta,
} from "@/components/ui/data-grid";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShortcutForm } from "@/components/ui/shortcut-form";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useShortcut } from "@/components/shortcuts/provider";

import { formatCents, parseNum, todayISO } from "./format";
import {
  useAssemble,
  useCreateType,
  useDeleteType,
  useEquipmentComponents,
  useEquipmentStock,
  useEquipmentTypes,
  useSetComponents,
  useUpdateType,
} from "./hooks";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type EquipmentCategory,
  type EquipmentComponentLine,
  type EquipmentStockRow,
  type EquipmentType,
} from "./types";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

// --- table model ---

interface TypeGridRow {
  type: EquipmentType;
  isVariant: boolean;
  stock: EquipmentStockRow | undefined;
  bom: EquipmentComponentLine[];
}

const gridFeatures = tableFeatures({});
const columnHelper = createColumnHelper<typeof gridFeatures, TypeGridRow>();

const rightAligned: DataGridColumnMeta = {
  align: "right",
  cellClassName: "tabular-nums",
};

// --- page ---

export function TypesView() {
  const types = useEquipmentTypes();
  const stock = useEquipmentStock();
  const components = useEquipmentComponents();

  const [editorState, setEditorState] = React.useState<{
    type?: EquipmentType;
    variantOf?: EquipmentType;
  } | null>(null);
  const [bomType, setBomType] = React.useState<EquipmentType | null>(null);
  const [assembleState, setAssembleState] = React.useState<{
    type: EquipmentType;
    action: "assemble" | "disassemble";
  } | null>(null);
  const [deleting, setDeleting] = React.useState<EquipmentType | null>(null);

  useShortcut("n", "New type", () => setEditorState({}));

  const typeList = React.useMemo(() => types.data ?? [], [types.data]);
  const stockByType = React.useMemo(() => {
    const map = new Map<string, EquipmentStockRow>();
    for (const row of stock.data ?? []) map.set(row.typeId, row);
    return map;
  }, [stock.data]);
  const bomByParent = React.useMemo(() => {
    const map = new Map<string, EquipmentComponentLine[]>();
    for (const line of components.data ?? []) {
      const list = map.get(line.parentTypeId) ?? [];
      list.push(line);
      map.set(line.parentTypeId, list);
    }
    return map;
  }, [components.data]);

  // One flat, category-ordered list: bases first, each followed by its
  // variants. A variant whose base no longer exists is shown at the top level
  // rather than hidden. Category becomes the grid's group header.
  const rows = React.useMemo<TypeGridRow[]>(() => {
    const byId = new Map(typeList.map((t) => [t.id, t]));
    const variantsOf = new Map<string, EquipmentType[]>();
    const bases: EquipmentType[] = [];
    for (const t of typeList) {
      if (t.variantOfTypeId && byId.has(t.variantOfTypeId)) {
        const list = variantsOf.get(t.variantOfTypeId) ?? [];
        list.push(t);
        variantsOf.set(t.variantOfTypeId, list);
      } else {
        bases.push(t);
      }
    }
    const toRow = (type: EquipmentType, isVariant: boolean): TypeGridRow => ({
      type,
      isVariant,
      stock: stockByType.get(type.id),
      bom: bomByParent.get(type.id) ?? [],
    });
    return CATEGORY_ORDER.flatMap((category) =>
      bases
        .filter((t) => t.category === category)
        .flatMap((base) => [
          toRow(base, false),
          ...(variantsOf.get(base.id) ?? []).map((v) => toRow(v, true)),
        ]),
    );
  }, [typeList, stockByType, bomByParent]);

  const columns = React.useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "name",
          header: "Type",
          cell: ({ row }) => {
            const { type, isVariant } = row.original;
            return (
              <div className="flex items-center gap-2">
                {isVariant && (
                  <CornerDownRight className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="font-medium">{type.name}</span>
                {type.framesPerBox != null && (
                  <Badge variant="outline">{type.framesPerBox} frames</Badge>
                )}
                {isVariant && <Badge variant="secondary">variant</Badge>}
              </div>
            );
          },
        }),
        columnHelper.display({
          id: "bom",
          header: "Built from",
          meta: {
            cellClassName: "text-sm text-muted-foreground",
          } satisfies DataGridColumnMeta,
          cell: ({ row }) =>
            row.original.bom.length === 0
              ? "—"
              : row.original.bom
                  .map((line) => `${line.quantity} × ${line.componentTypeName}`)
                  .join(" + "),
        }),
        columnHelper.display({
          id: "owned",
          header: "Owned",
          meta: rightAligned,
          cell: ({ row }) => row.original.stock?.totalOwned ?? 0,
        }),
        columnHelper.display({
          id: "available",
          header: "Available",
          meta: rightAligned,
          cell: ({ row }) => row.original.stock?.available ?? 0,
        }),
        columnHelper.display({
          id: "unitCost",
          header: "Unit cost",
          meta: rightAligned,
          cell: ({ row }) => formatCents(row.original.stock?.unitCostCents),
        }),
        columnHelper.display({
          id: "actions",
          header: "",
          meta: { cellClassName: "w-10 p-1 text-right" } satisfies DataGridColumnMeta,
          cell: ({ row }) => {
            const { type, isVariant, bom } = row.original;
            return (
              <DataGridCellAction className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Actions for ${type.name}`}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setEditorState({ type })}>
                    <Wrench />
                    Edit type
                  </DropdownMenuItem>
                  {!isVariant && (
                    <DropdownMenuItem
                      onSelect={() => setEditorState({ variantOf: type })}
                    >
                      <CornerDownRight />
                      Add variant
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setBomType(type)}>
                    <Hammer />
                    Bill of materials
                  </DropdownMenuItem>
                  {bom.length > 0 && (
                    <>
                      <DropdownMenuItem
                        onSelect={() =>
                          setAssembleState({ type, action: "assemble" })
                        }
                      >
                        Assemble…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          setAssembleState({ type, action: "disassemble" })
                        }
                      >
                        Disassemble…
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleting(type)}
                  >
                    Delete type
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              </DataGridCellAction>
            );
          },
        }),
      ]),
    [],
  );

  const table = useTable({
    features: gridFeatures,
    columns,
    data: rows,
    getRowId: (row) => row.type.id,
  });

  return (
    <div className="grid gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Equipment types &amp; BOMs
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The catalog behind your equipment stock: types, their varieties,
            and the bill of materials that lets you build one thing from
            others.
          </p>
        </div>
        <Button onClick={() => setEditorState({})}>
          <Plus />
          New type
        </Button>
      </header>

      {types.isPending ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : typeList.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No equipment types yet. Create one, or seed the standard catalog
            from the equipment page.
          </CardContent>
        </Card>
      ) : (
        <Card className="py-0">
          <CardContent className="p-0">
            <DataGrid
              table={table}
              aria-label="Equipment types"
              getRowGroup={(row) => row.type.category}
              renderGroupHeader={(category) =>
                CATEGORY_LABELS[category as EquipmentCategory]
              }
              onRowActivate={(row) => setEditorState({ type: row.type })}
              onRowDelete={(row) => setDeleting(row.type)}
            />
          </CardContent>
        </Card>
      )}

      <TypeDialog
        key={
          editorState
            ? `${editorState.type?.id ?? "new"}:${editorState.variantOf?.id ?? ""}`
            : "closed"
        }
        state={editorState}
        onClose={() => setEditorState(null)}
        allTypes={typeList}
      />
      {bomType && (
        <BomDialog
          type={bomType}
          allTypes={typeList}
          lines={bomByParent.get(bomType.id) ?? []}
          onClose={() => setBomType(null)}
        />
      )}
      {assembleState && (
        <AssembleDialog
          type={assembleState.type}
          action={assembleState.action}
          lines={bomByParent.get(assembleState.type.id) ?? []}
          stockByType={stockByType}
          onClose={() => setAssembleState(null)}
        />
      )}
      <DeleteTypeDialog type={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

// --- create / edit type ---

function TypeDialog({
  state,
  onClose,
  allTypes,
}: {
  state: { type?: EquipmentType; variantOf?: EquipmentType } | null;
  onClose: () => void;
  allTypes: EquipmentType[];
}) {
  const create = useCreateType();
  const update = useUpdateType();
  const editing = state?.type ?? null;

  const [name, setName] = React.useState(editing?.name ?? "");
  const [category, setCategory] = React.useState<string>(
    editing?.category ?? state?.variantOf?.category ?? "",
  );
  const [framesPerBox, setFramesPerBox] = React.useState(
    editing?.framesPerBox != null ? String(editing.framesPerBox) : "",
  );
  const [variantOf, setVariantOf] = React.useState(
    editing?.variantOfTypeId ?? state?.variantOf?.id ?? "none",
  );
  const [error, setError] = React.useState<string | undefined>();

  if (!state) return null;

  // A variant is the same kind of thing as its base, so only base types in the
  // chosen category are offered (and never the type being edited itself).
  const baseOptions = allTypes.filter(
    (t) =>
      !t.variantOfTypeId && t.id !== editing?.id && t.category === category,
  );
  const pending = create.isPending || update.isPending;
  const isBox = category === "box";

  // Changing category invalidates a base from the old category.
  function changeCategory(next: string) {
    setCategory(next);
    if (
      variantOf !== "none" &&
      !allTypes.some((t) => t.id === variantOf && t.category === next)
    ) {
      setVariantOf("none");
    }
  }

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Name is required");
      return;
    }
    if (!editing && category === "") {
      setError("Category is required");
      return;
    }
    const frames = parseNum(framesPerBox);
    if (framesPerBox.trim() !== "" && (frames == null || frames < 1)) {
      setError("Frames per box must be a whole number of 1 or more");
      return;
    }
    setError(undefined);
    const onSuccess = () => onClose();
    if (editing) {
      update.mutate(
        {
          typeId: editing.id,
          name: trimmed,
          category,
          ...(isBox && frames != null
            ? { framesPerBox: frames }
            : { clearFramesPerBox: true }),
          ...(variantOf === "none"
            ? { clearVariantOf: true }
            : { variantOfTypeId: variantOf }),
        },
        { onSuccess },
      );
    } else {
      create.mutate(
        {
          name: trimmed,
          category,
          ...(isBox && frames != null ? { framesPerBox: frames } : {}),
          ...(variantOf !== "none" ? { variantOfTypeId: variantOf } : {}),
        },
        { onSuccess },
      );
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing
              ? `Edit ${editing.name}`
              : state.variantOf
                ? `New variant of ${state.variantOf.name}`
                : "New equipment type"}
          </DialogTitle>
          <DialogDescription>
            {state.variantOf
              ? "A variant is a full type with its own stock and bill of materials, grouped under its base."
              : "Types are the catalog every stock row, deployment, and BOM refers to."}
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="type-editor-name">Name</Label>
            <Input
              id="type-editor-name"
              placeholder="e.g. Migratory Cover"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={changeCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_ORDER.map((c: EquipmentCategory) => (
                    <SelectItem key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isBox && (
              <div className="grid gap-1.5">
                <Label htmlFor="type-editor-frames">Frames per box</Label>
                <Input
                  id="type-editor-frames"
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={1}
                  placeholder="10"
                  value={framesPerBox}
                  onChange={(e) => setFramesPerBox(e.target.value)}
                />
              </div>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label>Variant of</Label>
            <Select
              value={variantOf}
              onValueChange={setVariantOf}
              disabled={category === ""}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None — a base type</SelectItem>
                {baseOptions.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {category === ""
                ? "Choose a category first."
                : baseOptions.length === 0
                  ? `No other ${CATEGORY_LABELS[
                      category as EquipmentCategory
                    ].toLowerCase()} to vary yet.`
                  : `Base types in ${CATEGORY_LABELS[
                      category as EquipmentCategory
                    ].toLowerCase()}.`}
            </p>
          </div>
          <FieldError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : editing ? "Save changes" : "Add type"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- bill of materials editor ---

interface BomDraftLine {
  componentTypeId: string;
  quantity: string;
}

function BomDialog({
  type,
  allTypes,
  lines,
  onClose,
}: {
  type: EquipmentType;
  allTypes: EquipmentType[];
  lines: EquipmentComponentLine[];
  onClose: () => void;
}) {
  const mutation = useSetComponents();
  const [draft, setDraft] = React.useState<BomDraftLine[]>(() =>
    lines.length > 0
      ? lines.map((l) => ({
          componentTypeId: l.componentTypeId,
          quantity: String(l.quantity),
        }))
      : [{ componentTypeId: "", quantity: "1" }],
  );
  const [error, setError] = React.useState<string | undefined>();

  const componentOptions = allTypes.filter((t) => t.id !== type.id);
  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    items: componentOptions.filter((t) => t.category === category),
  })).filter((group) => group.items.length > 0);

  const setLine = (index: number, patch: Partial<BomDraftLine>) =>
    setDraft((prev) =>
      prev.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    const filled = draft.filter((l) => l.componentTypeId !== "");
    const seen = new Set<string>();
    for (const line of filled) {
      const qty = parseNum(line.quantity);
      if (qty == null || !Number.isInteger(qty) || qty < 1) {
        setError("Every component needs a whole-number quantity of 1 or more");
        return;
      }
      if (seen.has(line.componentTypeId)) {
        setError("The same component appears twice");
        return;
      }
      seen.add(line.componentTypeId);
    }
    setError(undefined);
    mutation.mutate(
      {
        typeId: type.id,
        components: filled.map((l) => ({
          componentTypeId: l.componentTypeId,
          quantity: parseNum(l.quantity) ?? 1,
        })),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bill of materials · {type.name}</DialogTitle>
          <DialogDescription>
            What one {type.name} is built from. Assembling consumes these
            components; disassembling returns them.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            {draft.map((line, index) => (
              <div key={index} className="flex items-end gap-2">
                <div className="grid flex-1 gap-1.5">
                  {index === 0 && <Label>Component</Label>}
                  <Select
                    value={line.componentTypeId}
                    onValueChange={(value) =>
                      setLine(index, { componentTypeId: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a component" />
                    </SelectTrigger>
                    <SelectContent>
                      {grouped.map((group) => (
                        <SelectGroup key={group.category}>
                          <SelectLabel>
                            {CATEGORY_LABELS[group.category]}
                          </SelectLabel>
                          {group.items.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid w-24 gap-1.5">
                  {index === 0 && <Label>Qty</Label>}
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    min={1}
                    value={line.quantity}
                    onChange={(e) => setLine(index, { quantity: e.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove component"
                  onClick={() =>
                    setDraft((prev) => prev.filter((_, i) => i !== index))
                  }
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={() =>
                setDraft((prev) => [
                  ...prev,
                  { componentTypeId: "", quantity: "1" },
                ])
              }
            >
              <Plus />
              Add component
            </Button>
          </div>
          <FieldError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save BOM"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- assemble / disassemble ---

function AssembleDialog({
  type,
  action,
  lines,
  stockByType,
  onClose,
}: {
  type: EquipmentType;
  action: "assemble" | "disassemble";
  lines: EquipmentComponentLine[];
  stockByType: Map<string, EquipmentStockRow>;
  onClose: () => void;
}) {
  const mutation = useAssemble();
  const [quantity, setQuantity] = React.useState("1");
  const [date, setDate] = React.useState(todayISO());
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();

  const qty = parseNum(quantity);
  const validQty = qty != null && Number.isInteger(qty) && qty >= 1;
  const parentAvailable = stockByType.get(type.id)?.available ?? 0;

  const shortages =
    action === "assemble" && validQty
      ? lines.filter(
          (line) =>
            (stockByType.get(line.componentTypeId)?.available ?? 0) <
            line.quantity * (qty ?? 0),
        )
      : [];
  const disassembleShort =
    action === "disassemble" && validQty && parentAvailable < (qty ?? 0);

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!validQty) {
      setError("Quantity must be a whole number of 1 or more");
      return;
    }
    setError(undefined);
    mutation.mutate(
      {
        typeId: type.id,
        quantity: qty ?? 1,
        action,
        date,
        notes: notes.trim() || undefined,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {action === "assemble" ? "Assemble" : "Disassemble"} {type.name}
          </DialogTitle>
          <DialogDescription>
            {action === "assemble"
              ? "Consumes components from stock and adds finished units."
              : "Breaks finished units back down into their components."}
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm onSubmit={submit} className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="assemble-quantity">Quantity</Label>
              <Input
                id="assemble-quantity"
                type="number"
                inputMode="numeric"
                step={1}
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="assemble-date">Date</Label>
              <Input
                id="assemble-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          </div>

          <div className="rounded-md border p-3 text-sm">
            <p className="mb-2 font-medium">
              {action === "assemble" ? "Will consume" : "Will return"}
            </p>
            <ul className="grid gap-1">
              {lines.map((line) => {
                const available =
                  stockByType.get(line.componentTypeId)?.available ?? 0;
                const need = line.quantity * (validQty ? (qty ?? 0) : 0);
                const short = action === "assemble" && need > available;
                return (
                  <li
                    key={line.id}
                    className="flex items-center justify-between gap-3"
                  >
                    <span>
                      {need || line.quantity} × {line.componentTypeName}
                    </span>
                    {action === "assemble" && (
                      <span
                        className={
                          short
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }
                      >
                        {available} available
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {action === "disassemble" && (
              <p className="mt-2 text-muted-foreground">
                {parentAvailable} × {type.name} available to disassemble
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="assemble-notes">Notes</Label>
            <Textarea
              id="assemble-notes"
              rows={2}
              placeholder="Optional notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {shortages.length > 0 && (
            <FieldError
              message={`Not enough on hand: ${shortages
                .map((line) => line.componentTypeName)
                .join(", ")}`}
            />
          )}
          {disassembleShort && (
            <FieldError
              message={`Only ${parentAvailable} available to disassemble`}
            />
          )}
          <FieldError message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                shortages.length > 0 ||
                disassembleShort
              }
            >
              {mutation.isPending
                ? "Working…"
                : action === "assemble"
                  ? "Assemble"
                  : "Disassemble"}
            </Button>
          </DialogFooter>
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- delete ---

function DeleteTypeDialog({
  type,
  onClose,
}: {
  type: EquipmentType | null;
  onClose: () => void;
}) {
  const mutation = useDeleteType();
  return (
    <AlertDialog open={type != null} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {type?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Only a type with no stock history can be deleted; anything that
            has been stocked or deployed should be retired instead. Variants of
            this type become base types.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            onClick={() => {
              if (!type) return;
              mutation.mutate(type.id, { onSuccess: onClose });
            }}
          >
            {mutation.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
