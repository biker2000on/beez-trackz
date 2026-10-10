"use client";

/**
 * React binding for the desktop selection rules in `row-selection.ts`. Pass
 * the row ids in display order (every loaded page); hand the result to
 * `<DataGrid selection={…}>` for click / shift-click / ctrl-click, Space,
 * shift+arrow, Escape and Ctrl/Cmd+A.
 *
 * The selection is keyed by id, so loading another page keeps it. Ids that
 * stop being listed (a filter changed, a row left the ledger) are not
 * reported as selected, so counts and bulk actions never act on rows the
 * user cannot see.
 */

import * as React from "react";

import {
  EMPTY_SELECTION,
  reduceRowSelection,
  type RowSelectionAction,
  type RowSelectionState,
  type SelectModifiers,
} from "./row-selection";

export interface RowSelection {
  /** Selected ids that are currently listed. */
  selected: ReadonlySet<string>;
  anchor: string | null;
  count: number;
  /** True when every listed row is selected (and there is at least one). */
  allSelected: boolean;
  isSelected: (id: string) => boolean;
  click: (id: string, mods?: SelectModifiers) => void;
  toggle: (id: string, shift?: boolean) => void;
  extend: (from: string | null, to: string) => void;
  selectAll: () => void;
  clear: () => void;
}

export function useRowSelection(ids: readonly string[]): RowSelection {
  const idsRef = React.useRef(ids);
  React.useLayoutEffect(() => {
    idsRef.current = ids;
  });

  const [state, setState] = React.useState<RowSelectionState>(EMPTY_SELECTION);
  const apply = React.useCallback((action: RowSelectionAction) => {
    const current = idsRef.current;
    setState((previous) => reduceRowSelection(previous, action, current));
  }, []);

  const click = React.useCallback(
    (id: string, mods?: SelectModifiers) => apply({ type: "click", id, mods }),
    [apply],
  );
  const toggle = React.useCallback(
    (id: string, shift?: boolean) => apply({ type: "toggle", id, shift }),
    [apply],
  );
  const extend = React.useCallback(
    (from: string | null, to: string) => apply({ type: "extend", from, to }),
    [apply],
  );
  const selectAll = React.useCallback(() => apply({ type: "selectAll" }), [apply]);
  const clear = React.useCallback(() => apply({ type: "clear" }), [apply]);

  return React.useMemo(() => {
    const selected = new Set(ids.filter((id) => state.selected.has(id)));
    return {
      selected,
      anchor: state.anchor,
      count: selected.size,
      allSelected: ids.length > 0 && selected.size === ids.length,
      isSelected: (id: string) => selected.has(id),
      click,
      toggle,
      extend,
      selectAll,
      clear,
    };
  }, [ids, state, click, toggle, extend, selectAll, clear]);
}
