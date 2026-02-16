"use client";

import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "next-themes";
import { QueenNode } from "./queen-node";

interface QueenData {
  id: string;
  hiveId: string | null;
  origin: string;
  parentQueenId: string | null;
  introducedDate: Date | null;
  status: string;
  hiveName: string | null;
  apiaryName: string | null;
}

const nodeTypes = { queen: QueenNode };

function buildTree(queens: QueenData[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Build a map of children per parent
  const childrenMap = new Map<string | null, QueenData[]>();
  for (const q of queens) {
    const parentId = q.parentQueenId || null;
    if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
    childrenMap.get(parentId)!.push(q);
  }

  const HORIZONTAL_SPACING = 220;
  const VERTICAL_SPACING = 120;
  const visited = new Set<string>();

  function layoutSubtree(queenId: string, x: number, y: number): number {
    if (visited.has(queenId)) return x;
    visited.add(queenId);

    const children = childrenMap.get(queenId) || [];

    if (children.length === 0) {
      const queen = queens.find((q) => q.id === queenId)!;
      nodes.push({
        id: queenId,
        type: "queen",
        position: { x, y },
        data: {
          label: queen.hiveName || queen.origin,
          hiveName: queen.hiveName,
          apiaryName: queen.apiaryName,
          origin: queen.origin,
          status: queen.status,
          introducedDate: queen.introducedDate,
        },
      });
      return x + HORIZONTAL_SPACING;
    }

    // Layout children first
    let currentX = x;
    for (const child of children) {
      currentX = layoutSubtree(child.id, currentX, y + VERTICAL_SPACING);
      edges.push({
        id: `${queenId}-${child.id}`,
        source: queenId,
        target: child.id,
      });
    }

    // Place parent centered above children
    const queen = queens.find((q) => q.id === queenId)!;
    const centerX = (x + currentX - HORIZONTAL_SPACING) / 2;
    nodes.push({
      id: queenId,
      type: "queen",
      position: { x: centerX, y },
      data: {
        label: queen.hiveName || queen.origin,
        hiveName: queen.hiveName,
        apiaryName: queen.apiaryName,
        origin: queen.origin,
        status: queen.status,
        introducedDate: queen.introducedDate,
      },
    });

    return currentX;
  }

  // Find root queens (no parent or parent not in dataset)
  const queenIds = new Set(queens.map((q) => q.id));
  const roots = queens.filter(
    (q) => !q.parentQueenId || !queenIds.has(q.parentQueenId)
  );

  let xOffset = 0;
  for (const root of roots) {
    xOffset = layoutSubtree(root.id, xOffset, 0);
    xOffset += HORIZONTAL_SPACING; // Gap between separate lineages
  }

  // Layout any remaining unvisited queens (shouldn't happen with the above logic, but just in case)
  for (const queen of queens) {
    if (!visited.has(queen.id)) {
      layoutSubtree(queen.id, xOffset, 0);
      xOffset += HORIZONTAL_SPACING;
    }
  }

  return { nodes, edges };
}

interface QueenTreeProps {
  queens: QueenData[];
}

export function QueenTree({ queens }: QueenTreeProps) {
  const { resolvedTheme } = useTheme();
  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => buildTree(queens),
    [queens]
  );

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  if (queens.length === 0) {
    return (
      <p className="text-muted-foreground p-4">No queens recorded yet.</p>
    );
  }

  return (
    <div className="h-[600px] border rounded-lg">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
