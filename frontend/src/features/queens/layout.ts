import type { Edge, Node } from "@xyflow/react";

import type { Queen } from "./api";

export type QueenFlowNode = Node<
  { queen: Queen; score?: number; inspections?: number },
  "queen"
>;

/** Horizontal distance between sibling columns. */
const H_SPACING = 220;
/** Vertical distance between generations. */
const V_SPACING = 120;
/** Extra horizontal gap separating unrelated lineages. */
const LINEAGE_GAP = 120;

function byIntroduced(a: Queen, b: Queen): number {
  const da = a.introducedDate ?? "";
  const db = b.introducedDate ?? "";
  return da.localeCompare(db) || a.id.localeCompare(b.id);
}

/**
 * Lays the queens out as a forest: children in a row beneath their parent,
 * parents centered over their children, separate lineages spaced apart.
 * Pure function of the queen list so the tree rebuilds whenever data changes.
 */
export function layoutQueenTree(
  queens: Queen[],
  performance: Map<string, { score: number; inspections: number }> = new Map(),
): {
  nodes: QueenFlowNode[];
  edges: Edge[];
} {
  const byId = new Map(queens.map((q) => [q.id, q]));
  const children = new Map<string, Queen[]>();
  const roots: Queen[] = [];

  for (const queen of queens) {
    const parentId = queen.parentQueenId;
    if (parentId && byId.has(parentId)) {
      const siblings = children.get(parentId);
      if (siblings) siblings.push(queen);
      else children.set(parentId, [queen]);
    } else {
      roots.push(queen);
    }
  }
  roots.sort(byIntroduced);
  for (const siblings of children.values()) siblings.sort(byIntroduced);

  const positions = new Map<string, { x: number; y: number }>();
  let cursor = 0;

  // Post-order: leaves claim the next free column, parents center over kids.
  function place(queen: Queen, depth: number): number {
    const kids = children.get(queen.id) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = cursor;
      cursor += H_SPACING;
    } else {
      const xs = kids.map((kid) => place(kid, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    positions.set(queen.id, { x, y: depth * V_SPACING });
    return x;
  }

  for (const root of roots) {
    place(root, 0);
    cursor += LINEAGE_GAP;
  }

  const nodes: QueenFlowNode[] = queens.map((queen) => ({
    id: queen.id,
    type: "queen",
    position: positions.get(queen.id) ?? { x: 0, y: 0 },
    data: {
      queen,
      score: performance.get(queen.id)?.score,
      inspections: performance.get(queen.id)?.inspections,
    },
  }));

  const edges: Edge[] = queens
    .filter((q) => q.parentQueenId && byId.has(q.parentQueenId))
    .map((q) => ({
      id: `${q.parentQueenId}-${q.id}`,
      source: q.parentQueenId as string,
      target: q.id,
      type: "smoothstep",
    }));

  return { nodes, edges };
}
