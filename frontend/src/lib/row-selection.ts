/**
 * Desktop list-selection rules (Finder / Explorer / the Folio ledger's
 * shift-click range), as a pure reducer so the rules can be unit tested
 * without React.
 *
 * - plain click: select only that row; it becomes the anchor;
 * - ctrl/cmd click (and a checkbox click or Space): toggle that row; it
 *   becomes the anchor;
 * - shift click: select the contiguous range from the anchor to the row,
 *   replacing the selection (ctrl/cmd+shift adds the range instead);
 * - shift on a checkbox or Space: add the range from the anchor to the row,
 *   then move the anchor there (the Gmail / Folio checkbox convention);
 * - shift+arrow: extend from the anchor to the newly focused row;
 * - select all: every loaded row; clear: nothing, no anchor.
 *
 * Ranges are computed over `ids` — the rows in their displayed order, across
 * every page loaded so far — so a range can span a page boundary. An anchor
 * that is no longer in `ids` (filtered away) behaves as if there were none.
 */

export interface RowSelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

export interface SelectModifiers {
  /** Shift held: select a range from the anchor. */
  shift?: boolean;
  /** Ctrl (or Cmd on macOS) held: toggle instead of replace. */
  toggle?: boolean;
}

export type RowSelectionAction =
  | { type: "click"; id: string; mods?: SelectModifiers }
  | { type: "toggle"; id: string; shift?: boolean }
  | { type: "extend"; from: string | null; to: string }
  | { type: "selectAll" }
  | { type: "clear" };

export const EMPTY_SELECTION: RowSelectionState = {
  selected: new Set(),
  anchor: null,
};

/** The ids from `a` to `b` inclusive, in display order; empty if either is missing. */
export function idRange(ids: readonly string[], a: string, b: string): string[] {
  const start = ids.indexOf(a);
  const end = ids.indexOf(b);
  if (start < 0 || end < 0) return [];
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  return ids.slice(lo, hi + 1);
}

export function reduceRowSelection(
  state: RowSelectionState,
  action: RowSelectionAction,
  ids: readonly string[],
): RowSelectionState {
  const anchor =
    state.anchor !== null && ids.includes(state.anchor) ? state.anchor : null;

  switch (action.type) {
    case "click": {
      const { id, mods = {} } = action;
      if (mods.shift && anchor !== null) {
        const range = idRange(ids, anchor, id);
        const selected = mods.toggle
          ? new Set([...state.selected, ...range])
          : new Set(range);
        return { selected, anchor };
      }
      if (mods.toggle) {
        const selected = new Set(state.selected);
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        return { selected, anchor: id };
      }
      return { selected: new Set([id]), anchor: id };
    }
    case "toggle": {
      const { id, shift } = action;
      if (shift && anchor !== null) {
        return {
          selected: new Set([...state.selected, ...idRange(ids, anchor, id)]),
          anchor: id,
        };
      }
      const selected = new Set(state.selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { selected, anchor: id };
    }
    case "extend": {
      const start = anchor ?? action.from ?? action.to;
      return { selected: new Set(idRange(ids, start, action.to)), anchor: start };
    }
    case "selectAll":
      return { selected: new Set(ids), anchor: state.anchor };
    case "clear":
      return EMPTY_SELECTION;
  }
}
