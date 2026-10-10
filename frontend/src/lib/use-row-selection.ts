"use client";

/**
 * React binding for the desktop selection rules in `row-selection.ts`. Pass
 * the row ids in display order (every loaded page); hand the result to
 * `<DataGrid selection={…}>` for click / shift-click / ctrl-click, Space,
 * shift+arrow, Escape and Ctrl/Cmd+A.
 *
 * The grid may sort, filter or search its rows locally; it then passes its
 * visible ids (in visible order) as the optional `order` argument, so shift
 * ranges and select-all follow what the user sees rather than `ids`.
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
  /** `order`: the ids a range runs over (default: every listed id). */
  click: (id: string, mods?: SelectModifiers, order?: readonly string[]) => void;
  toggle: (id: string, shift?: boolean, order?: readonly string[]) => void;
  extend: (from: string | null, to: string, order?: readonly string[]) => void;
  /** Selects every id in `order` (default: every listed id). */
  selectAll: (order?: readonly string[]) => void;
  clear: () => void;
}

export function useRowSelection(ids: readonly string[]): RowSelection {
  const idsRef = React.useRef(ids);
  React.useLayoutEffect(() => {
    idsRef.current = ids;
  });

  const [state, setState] = React.useState<RowSelectionState>(EMPTY_SELECTION);
  const apply = React.useCallback(
    (action: RowSelectionAction, order?: readonly string[]) => {
      const current = order ?? idsRef.current;
      setState((previous) => reduceRowSelection(previous, action, current));
    },
    [],
  );

  const click = React.useCallback(
    (id: string, mods?: SelectModifiers, order?: readonly string[]) =>
      apply({ type: "click", id, mods }, order),
    [apply],
  );
  const toggle = React.useCallback(
    (id: string, shift?: boolean, order?: readonly string[]) =>
      apply({ type: "toggle", id, shift }, order),
    [apply],
  );
  const extend = React.useCallback(
    (from: string | null, to: string, order?: readonly string[]) =>
      apply({ type: "extend", from, to }, order),
    [apply],
  );
  const selectAll = React.useCallback(
    (order?: readonly string[]) => apply({ type: "selectAll" }, order),
    [apply],
  );
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
