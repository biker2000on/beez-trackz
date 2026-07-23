"use client";

import * as React from "react";
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type ColorMode,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CheckSquare, Crown, Network, Plus } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useShortcut } from "@/components/shortcuts/provider";

import {
  QUEEN_STATUSES,
  QUEEN_STATUS_LABELS,
  useBulkUpdateQueens,
  useQueens,
  type Queen,
  type QueenStatus,
} from "./api";
import { layoutQueenTree, type QueenFlowNode } from "./layout";
import { markingColorForDate, markingColorForYear } from "./marking";
import { QueenDetailsSheet } from "./queen-details-sheet";
import { QueenFormDialog } from "./queen-form-dialog";
import { QueenNode } from "./queen-node";

const nodeTypes = { queen: QueenNode };

function MarkingLegend() {
  const thisYear = new Date().getFullYear();
  const base = thisYear - (thisYear % 5);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {[0, 1, 2, 3, 4].map((offset) => {
        const marking = markingColorForYear(base + offset);
        return (
          <span key={offset} className="flex items-center gap-1">
            <span
              className={
                marking.needsBorder
                  ? "size-2.5 rounded-full border border-stone-400"
                  : "size-2.5 rounded-full"
              }
              style={{ backgroundColor: marking.color }}
            />
            {marking.name} ({String(base + offset).slice(-1)}/
            {String(base + offset + 5).slice(-1)})
          </span>
        );
      })}
    </div>
  );
}

export function GenealogyView() {
  const queensQuery = useQueens();
  const { resolvedTheme } = useTheme();

  const [formOpen, setFormOpen] = React.useState(false);
  const [editingQueen, setEditingQueen] = React.useState<Queen | undefined>();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [manageMode, setManageMode] = React.useState(false);
  const [bulkSelected, setBulkSelected] = React.useState<Set<string>>(
    new Set(),
  );
  const bulkUpdate = useBulkUpdateQueens();

  const queens = React.useMemo(
    () => queensQuery.data ?? [],
    [queensQuery.data],
  );

  // Layout is a pure function of the queen list, and the effect below pushes
  // every fresh layout into React Flow — the tree always reflects the latest
  // query data (the legacy version cached a stale memo and never refreshed).
  const layout = React.useMemo(() => layoutQueenTree(queens), [queens]);

  const [nodes, setNodes, onNodesChange] = useNodesState<QueenFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  React.useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
  }, [layout, setNodes, setEdges]);

  const openCreate = React.useCallback(() => {
    setEditingQueen(undefined);
    setFormOpen(true);
  }, []);

  useShortcut("n", "New queen", openCreate);
  useShortcut("b", "Toggle bulk-manage queens", () => {
    setManageMode((active) => {
      if (active) setBulkSelected(new Set());
      return !active;
    });
  });
  useShortcut("x", "Select all queens", () => {
    if (!manageMode) return;
    setBulkSelected(
      bulkSelected.size === queens.length
        ? new Set()
        : new Set(queens.map((queen) => queen.id)),
    );
  });

  const onNodeClick: NodeMouseHandler = React.useCallback((_event, node) => {
    setSelectedId(node.id);
  }, []);

  // Resolve from fresh query data so edits show up immediately in the sheet.
  const selectedQueen = selectedId
    ? (queens.find((q) => q.id === selectedId) ?? null)
    : null;

  function handleEdit(queen: Queen) {
    setEditingQueen(queen);
    setFormOpen(true);
  }

  function toggleBulkSelected(id: string) {
    setBulkSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function setSelectedStatus(status: QueenStatus) {
    const targets = queens.filter((queen) => bulkSelected.has(queen.id));
    if (targets.length === 0) return;
    try {
      const count = await bulkUpdate.mutateAsync({ queens: targets, status });
      toast.success(
        `${count} queen${count === 1 ? "" : "s"} marked ${QUEEN_STATUS_LABELS[
          status
        ].toLowerCase()}`,
      );
      setBulkSelected(new Set());
      setManageMode(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Bulk update failed");
    }
  }

  const colorMode: ColorMode = resolvedTheme === "dark" ? "dark" : "light";

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Queens</h1>
          <p className="text-sm text-muted-foreground">
            Family tree of your queens, colored by international marking year.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={manageMode ? "secondary" : "outline"}
            onClick={() => {
              setManageMode((active) => !active);
              setBulkSelected(new Set());
            }}
          >
            {manageMode ? <Network /> : <CheckSquare />}
            {manageMode ? "Tree view" : "Bulk manage"}
          </Button>
          <Button onClick={openCreate}>
            <Plus />
            Add queen
          </Button>
        </div>
      </div>
      <MarkingLegend />

      {queensQuery.isLoading ? (
        <Skeleton className="h-[60vh] min-h-96 w-full rounded-xl" />
      ) : queensQuery.isError ? (
        <Card>
          <CardHeader className="items-center py-10 text-center">
            <CardTitle>Could not load queens</CardTitle>
            <CardDescription>
              <button
                type="button"
                className="font-medium text-primary underline-offset-4 hover:underline"
                onClick={() => queensQuery.refetch()}
              >
                Try again
              </button>
            </CardDescription>
          </CardHeader>
        </Card>
      ) : queens.length === 0 ? (
        <Card>
          <CardHeader className="items-center py-10 text-center">
            <Crown className="mb-2 size-10 text-primary/40" />
            <CardTitle>No queens yet</CardTitle>
            <CardDescription>
              Add your first queen to start tracking lineages.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center pb-10">
            <Button onClick={openCreate}>
              <Plus />
              Add queen
            </Button>
          </CardContent>
        </Card>
      ) : manageMode ? (
        <div className="grid gap-2">
          {queens.map((queen) => {
            const marking = markingColorForDate(queen.introducedDate);
            return (
              <button
                key={queen.id}
                type="button"
                className={`flex min-h-14 items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors ${
                  bulkSelected.has(queen.id)
                    ? "border-primary bg-primary/5"
                    : "hover:border-primary/40"
                }`}
                onClick={() => toggleBulkSelected(queen.id)}
              >
                <Checkbox
                  checked={bulkSelected.has(queen.id)}
                  tabIndex={-1}
                  aria-hidden="true"
                  className="pointer-events-none"
                />
                <span
                  className="size-3 shrink-0 rounded-full border"
                  style={{ backgroundColor: marking?.color ?? "transparent" }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {queen.apiaryName && queen.hiveName
                      ? `${queen.apiaryName} — ${queen.hiveName}`
                      : "Unassigned queen"}
                  </span>
                  <span className="block text-xs capitalize text-muted-foreground">
                    {queen.origin.replaceAll("_", " ")}
                    {marking ? ` · ${marking.year}` : ""}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {QUEEN_STATUS_LABELS[queen.status]}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="h-[calc(100dvh-19rem)] min-h-96 overflow-hidden rounded-xl border bg-card">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            colorMode={colorMode}
            onNodeClick={onNodeClick}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.2}
            maxZoom={2}
            nodesConnectable={false}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}

      {manageMode && queens.length > 0 && (
        <div className="sticky bottom-20 z-20 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3 shadow-lg md:bottom-4">
          <span className="text-sm font-medium">
            {bulkSelected.size} selected
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setBulkSelected(
                bulkSelected.size === queens.length
                  ? new Set()
                  : new Set(queens.map((queen) => queen.id)),
              )
            }
          >
            {bulkSelected.size === queens.length ? "Clear all" : "Select all"}
          </Button>
          <Select
            value=""
            onValueChange={(value) =>
              void setSelectedStatus(value as QueenStatus)
            }
          >
            <SelectTrigger
              className="ml-auto w-44"
              disabled={bulkSelected.size === 0 || bulkUpdate.isPending}
            >
              <SelectValue placeholder="Set status…" />
            </SelectTrigger>
            <SelectContent>
              {QUEEN_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {QUEEN_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <QueenFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        queen={editingQueen}
        queens={queens}
      />
      <QueenDetailsSheet
        queen={selectedQueen}
        queens={queens}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onEdit={handleEdit}
      />
    </div>
  );
}
