"use client";

import * as React from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/features/settings/gnucash-format";
import {
  useCreateFinanceCategory,
  useDeleteFinanceCategory,
  useFinanceCategories,
  useReorderFinanceCategories,
  useUpdateFinanceCategory,
  type FinanceCategory,
  type FinanceKind,
} from "@/features/settings/finance-categories-api";

/**
 * Operation setup › Expense and income categories: the single editor for
 * both lists (config registry key `finance-categories`). Add, rename inline,
 * move up or down, archive or unarchive, and delete a category nothing uses.
 * Built-in categories Atlas relies on can only be renamed.
 */
export function FinanceCategoriesSection() {
  return (
    <div className="grid gap-6 md:grid-cols-2" data-config-editor="finance-categories">
      <CategoryList kind="expense" title="Expense categories" />
      <CategoryList kind="income" title="Income categories" />
    </div>
  );
}

function CategoryList({ kind, title }: { kind: FinanceKind; title: string }) {
  const list = useFinanceCategories(kind);
  const create = useCreateFinanceCategory();
  const reorder = useReorderFinanceCategories();
  const [newLabel, setNewLabel] = React.useState("");
  const headingId = React.useId();
  const rows = list.categories;

  function add(event: React.FormEvent) {
    event.preventDefault();
    const label = newLabel.trim();
    if (!label) return;
    create.mutate(
      { kind, label },
      {
        onSuccess: () => {
          toast.success(`Added "${label}"`);
          setNewLabel("");
        },
        onError: (error) => toast.error(errorMessage(error, "Could not add the category")),
      },
    );
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const ids = rows.map((row) => row.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate(
      { kind, ids },
      { onError: (error) => toast.error(errorMessage(error, "Could not reorder")) },
    );
  }

  return (
    <section className="grid content-start gap-3" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-sm font-semibold">
        {title}
      </h3>
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : !list.loaded ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {list.isError
            ? "Could not load the categories."
            : "No categories were returned."}{" "}
          The built-in list is used until they load.
        </p>
      ) : (
        <ul className="grid gap-1.5" aria-label={title}>
          {rows.map((row, index) => (
            <CategoryRow
              key={row.id}
              row={row}
              first={index === 0}
              last={index === rows.length - 1}
              busy={reorder.isPending}
              onMove={(delta) => move(index, delta)}
            />
          ))}
        </ul>
      )}
      <form className="flex gap-2" onSubmit={add}>
        <Input
          value={newLabel}
          onChange={(event) => setNewLabel(event.target.value)}
          placeholder={kind === "expense" ? "New expense category" : "New income category"}
          aria-label={`New ${kind} category name`}
          maxLength={80}
          disabled={!list.loaded}
        />
        <Button type="submit" size="sm" disabled={!list.loaded || !newLabel.trim() || create.isPending}>
          <Plus /> Add
        </Button>
      </form>
    </section>
  );
}

function CategoryRow({
  row,
  first,
  last,
  busy,
  onMove,
}: {
  row: FinanceCategory;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMove: (delta: -1 | 1) => void;
}) {
  const update = useUpdateFinanceCategory();
  const remove = useDeleteFinanceCategory();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(row.label);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const pending = busy || update.isPending || remove.isPending;

  function startRename() {
    setDraft(row.label);
    setEditing(true);
  }

  function saveRename() {
    const label = draft.trim();
    if (!label || label === row.label) {
      setEditing(false);
      return;
    }
    update.mutate(
      { id: row.id, label },
      {
        onSuccess: () => {
          toast.success(`Renamed to "${label}"`);
          setEditing(false);
        },
        onError: (error) => toast.error(errorMessage(error, "Could not rename the category")),
      },
    );
  }

  function setArchived(archived: boolean) {
    update.mutate(
      { id: row.id, archived },
      {
        onSuccess: () =>
          toast.success(archived ? `Archived "${row.label}"` : `Restored "${row.label}"`),
        onError: (error) => toast.error(errorMessage(error, "Could not update the category")),
      },
    );
  }

  function deleteRow() {
    remove.mutate(row.id, {
      onSuccess: () => toast.success(`Deleted "${row.label}"`),
      onError: (error) => {
        setConfirmDelete(false);
        toast.error(errorMessage(error, "Could not delete the category"));
      },
    });
  }

  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5"
      data-category-key={row.key}
      aria-label={row.label}
    >
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${row.label} up`}
          disabled={first || pending}
          onClick={() => onMove(-1)}
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${row.label} down`}
          disabled={last || pending}
          onClick={() => onMove(1)}
        >
          <ArrowDown />
        </Button>
      </div>
      {editing ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            saveRename();
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
            aria-label={`Name for ${row.label}`}
            maxLength={80}
            className="h-8"
            autoFocus
          />
          <Button type="submit" variant="ghost" size="icon-sm" aria-label="Save name" disabled={pending}>
            <Check />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel rename"
            onClick={() => setEditing(false)}
          >
            <X />
          </Button>
        </form>
      ) : (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className={row.archived ? "text-sm text-muted-foreground line-through" : "text-sm"}>
            {row.label}
          </span>
          {row.isSystem ? <Badge variant="secondary">Built in</Badge> : null}
          {row.archived ? <Badge variant="outline">Archived</Badge> : null}
          <span className="text-xs text-muted-foreground tabular-nums">
            {row.usageCount === 1 ? "1 entry" : `${row.usageCount} entries`}
          </span>
        </div>
      )}
      {!editing ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Rename ${row.label}`}
            disabled={pending}
            onClick={startRename}
          >
            <Pencil />
          </Button>
          {row.isSystem ? null : row.archived ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Unarchive ${row.label}`}
              disabled={pending}
              onClick={() => setArchived(false)}
            >
              <ArchiveRestore />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Archive ${row.label}`}
              disabled={pending}
              onClick={() => setArchived(true)}
            >
              <Archive />
            </Button>
          )}
          {row.deletable ? (
            confirmDelete ? (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  onClick={deleteRow}
                >
                  Delete
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Keep category"
                  onClick={() => setConfirmDelete(false)}
                >
                  <X />
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${row.label}`}
                disabled={pending}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 />
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
