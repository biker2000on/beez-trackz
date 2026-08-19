"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  CheckSquare,
  LayoutGrid,
  Plus,
  Table2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
import { useShortcut } from "@/components/shortcuts/provider";
import { useBulkSelect } from "@/lib/use-bulk-select";
import { useApiaries } from "@/features/apiaries/hooks";
import { HiveCard, HiveStatusBadge } from "./hive-card";
import { HiveFormDialog } from "./hive-form-dialog";
import { useBulkUpdateHives, useHives } from "./hooks";
import { HIVE_STATUSES, HIVE_STATUS_LABELS, formatDate } from "./lib";

const VIEW_STORAGE_KEY = "beez.hives.view";
const ALL = "all";

type ViewMode = "card" | "table";

export function HivesListPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const showArchived = searchParams.get("archived") === "1";
  const [apiaryFilter, setApiaryFilter] = React.useState(ALL);
  const [statusFilter, setStatusFilter] = React.useState(ALL);

  // View toggle, persisted in localStorage (read after mount so the
  // server-prerendered markup matches the first client render).
  const [view, setView] = React.useState<ViewMode>("card");
  React.useEffect(() => {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    // Rehydrate this browser-only preference after the server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored === "card" || stored === "table") setView(stored);
  }, []);
  function changeView(next: ViewMode) {
    setView(next);
    window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  }

  const apiaries = useApiaries();
  const hives = useHives({
    apiaryId: apiaryFilter === ALL ? undefined : apiaryFilter,
    status: statusFilter === ALL ? undefined : statusFilter,
    includeArchived: showArchived,
  });

  const [createOpen, setCreateOpen] = React.useState(false);
  const bulkUpdate = useBulkUpdateHives();
  const {
    bulkMode,
    selected,
    setSelected,
    toggle: toggleSelect,
    toggleMode,
    exit: exitBulkMode,
    finish: finishBulk,
  } = useBulkSelect(
    (hives.data ?? []).map((hive) => hive.id),
    { selectAll: "Select all visible hives" },
  );

  useShortcut("n", "New hive", () => setCreateOpen(true));

  function setArchivedParam(next: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("archived", "1");
    else params.delete("archived");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  async function applyBulk(payload: {
    status?: string;
    isArchived?: boolean;
  }) {
    if (selected.size === 0) {
      toast.error("Select at least one hive");
      return;
    }
    try {
      const result = await bulkUpdate.mutateAsync({
        hiveIds: Array.from(selected),
        ...payload,
      });
      toast.success(
        `Updated ${result.count} hive${result.count === 1 ? "" : "s"}`,
      );
      finishBulk();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not update hives",
      );
    }
  }

  const list = hives.data ?? [];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Hives</h1>
        <div className="flex items-center gap-2">
          <Button
            variant={bulkMode ? "secondary" : "outline"}
            onClick={toggleMode}
          >
            <CheckSquare className="size-4" />
            {bulkMode ? "Done" : "Bulk select"}
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New hive
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label className="text-xs">Apiary</Label>
          <Select value={apiaryFilter} onValueChange={setApiaryFilter}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All apiaries</SelectItem>
              {apiaries.data?.map((apiary) => (
                <SelectItem key={apiary.id} value={apiary.id}>
                  {apiary.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {HIVE_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {HIVE_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox
            checked={showArchived}
            onCheckedChange={(checked) => setArchivedParam(checked === true)}
          />
          Show archived
        </label>
        <div className="ml-auto flex items-center gap-1 rounded-md border p-0.5">
          <Button
            variant={view === "card" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Card view"
            onClick={() => changeView("card")}
          >
            <LayoutGrid className="size-4" />
          </Button>
          <Button
            variant={view === "table" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Table view"
            onClick={() => changeView("table")}
          >
            <Table2 className="size-4" />
          </Button>
        </div>
      </div>

      {hives.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : hives.isError ? (
        <p className="text-sm text-muted-foreground">
          Could not load hives.{" "}
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => hives.refetch()}
          >
            Retry
          </button>
        </p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No hives match these filters.
        </p>
      ) : view === "card" ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((hive) => (
            <HiveCard
              key={hive.id}
              hive={hive}
              selectable={bulkMode}
              selected={selected.has(hive.id)}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                {bulkMode && (
                  <TableHead className="w-10">
                    <span className="sr-only">Selected</span>
                  </TableHead>
                )}
                <TableHead>Hive</TableHead>
                <TableHead>Apiary</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Installed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((hive) => (
                <TableRow
                  key={hive.id}
                  className={
                    bulkMode
                      ? "cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-primary"
                      : undefined
                  }
                  // The row itself is the control in bulk mode: focusable,
                  // Space/Enter toggles, and `aria-selected` reports state.
                  tabIndex={bulkMode ? 0 : undefined}
                  aria-selected={bulkMode ? selected.has(hive.id) : undefined}
                  data-state={
                    bulkMode && selected.has(hive.id) ? "selected" : undefined
                  }
                  onClick={
                    bulkMode ? () => toggleSelect(hive.id) : undefined
                  }
                  onKeyDown={
                    bulkMode
                      ? (event) => {
                          if (event.key !== " " && event.key !== "Enter") return;
                          if (event.target !== event.currentTarget) return;
                          event.preventDefault();
                          toggleSelect(hive.id);
                        }
                      : undefined
                  }
                >
                  {bulkMode && (
                    <TableCell>
                      <Checkbox
                        checked={selected.has(hive.id)}
                        aria-hidden
                        tabIndex={-1}
                        className="pointer-events-none"
                      />
                    </TableCell>
                  )}
                  <TableCell className="font-medium">
                    {/* The name stays a link in bulk mode so a row can be
                        opened for a second look without losing the selection. */}
                    <Link
                      href={`/hives/${hive.id}`}
                      className="underline-offset-4 hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {hive.positionLabel}
                    </Link>
                    {hive.isArchived && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (archived)
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{hive.apiaryName}</TableCell>
                  <TableCell>
                    <HiveStatusBadge status={hive.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(hive.installedDate)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {bulkMode && (
        <div className="sticky bottom-[calc(var(--bottom-nav-h)+0.75rem)] z-20 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 shadow-lg lg:bottom-4">
          <span className="text-sm font-medium">
            {selected.size} selected
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setSelected(
                selected.size === list.length
                  ? new Set()
                  : new Set(list.map((hive) => hive.id)),
              )
            }
          >
            {selected.size === list.length ? "Clear all" : "Select all"}
          </Button>
          <Select
            value=""
            onValueChange={(status) => void applyBulk({ status })}
          >
            <SelectTrigger className="w-36" disabled={bulkUpdate.isPending}>
              <SelectValue placeholder="Set status…" />
            </SelectTrigger>
            <SelectContent>
              {HIVE_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {HIVE_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void applyBulk({ isArchived: true })}
            disabled={bulkUpdate.isPending}
          >
            <Archive className="size-4" />
            Archive
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void applyBulk({ isArchived: false })}
            disabled={bulkUpdate.isPending}
          >
            <ArchiveRestore className="size-4" />
            Unarchive
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Exit bulk select"
            onClick={exitBulkMode}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}

      <HiveFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
