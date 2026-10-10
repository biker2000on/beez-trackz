"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";

/** The account shape the Folio account list returns. */
export interface SelectableAccount {
  guid: string;
  name: string;
  fullName: string;
  type: string;
  placeholder?: boolean;
  hidden?: boolean;
}

interface AccountSelectorProps {
  id?: string;
  /** The selected GUID, or "" for none. */
  value: string;
  accounts: SelectableAccount[];
  onChange: (guid: string) => void;
  /** Label of the option that clears the value to "". Omit to offer none. */
  clearLabel?: string;
  /**
   * Shown for a value that is not in `accounts` (e.g. an account since deleted
   * in the book), so the stored mapping is never silently blanked.
   */
  missingLabel?: (guid: string) => string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/** Full colon path, falling back to the leaf name. */
function accountPath(account: SelectableAccount): string {
  return account.fullName || account.name;
}

type Option =
  | { kind: "clear"; key: string; label: string }
  | { kind: "account"; key: string; account: SelectableAccount };

/**
 * Type-to-search account picker, ported from Folio's AccountSelector: the
 * input filters by full account path (or account type) as you type, the list
 * is grouped by account type and scrolls, and ArrowUp/ArrowDown/Enter/Escape
 * drive it from the keyboard with the focused row kept in view.
 *
 * Like Folio, ROOT accounts are never offered; placeholder and hidden
 * accounts are listed (and selectable — Folio does not disable them) but
 * labelled so the operator can tell.
 */
export function AccountSelector({
  id,
  value,
  accounts,
  onChange,
  clearLabel,
  missingLabel = (guid) => `${guid} (missing)`,
  placeholder = "Select account…",
  disabled = false,
  className,
}: AccountSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [focusedIndex, setFocusedIndex] = React.useState(0);
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const listId = React.useId();

  const selected = accounts.find((account) => account.guid === value);
  const selectedLabel = value
    ? selected
      ? accountPath(selected)
      : missingLabel(value)
    : clearLabel ?? "";

  // Filter, then group by type in first-seen order.
  const groups = React.useMemo(() => {
    const needle = search.trim().toLowerCase();
    const byType = new Map<string, SelectableAccount[]>();
    for (const account of accounts) {
      if (account.type === "ROOT") continue;
      if (
        needle &&
        !accountPath(account).toLowerCase().includes(needle) &&
        !account.type.toLowerCase().includes(needle)
      ) {
        continue;
      }
      const list = byType.get(account.type) ?? [];
      list.push(account);
      byType.set(account.type, list);
    }
    return Array.from(byType.entries());
  }, [accounts, search]);

  // One flat list for keyboard navigation: the clear option (only while not
  // searching) and then every visible account in display order.
  const options = React.useMemo(() => {
    const result: Option[] = [];
    if (clearLabel && search.trim() === "") {
      result.push({ kind: "clear", key: "__clear__", label: clearLabel });
    }
    for (const [, list] of groups) {
      for (const account of list) {
        result.push({ kind: "account", key: account.guid, account });
      }
    }
    return result;
  }, [groups, clearLabel, search]);

  function openList() {
    if (disabled) return;
    setSearch("");
    const current = options.findIndex((option) =>
      option.kind === "clear" ? value === "" : option.account.guid === value,
    );
    setFocusedIndex(current >= 0 ? current : 0);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setSearch("");
  }

  function choose(option: Option) {
    onChange(option.kind === "clear" ? "" : option.account.guid);
    close();
  }

  // Keep the focused row in view as the keyboard moves through a long list.
  React.useEffect(() => {
    if (!open) return;
    itemRefs.current[focusedIndex]?.scrollIntoView({ block: "nearest" });
  }, [focusedIndex, open]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "Enter") {
        event.preventDefault();
        openList();
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setFocusedIndex((index) => Math.min(index + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setFocusedIndex((index) => Math.max(index - 1, 0));
        break;
      case "Enter": {
        event.preventDefault();
        const option = options[focusedIndex];
        if (option) choose(option);
        break;
      }
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "Tab":
        close();
        break;
    }
  }

  let index = 0;
  const clearOption = options[0]?.kind === "clear" ? options[0] : null;

  function renderOption(option: Option, label: React.ReactNode) {
    const current = index++;
    const isSelected =
      option.kind === "clear" ? value === "" : option.account.guid === value;
    return (
      <div
        key={option.key}
        id={`${listId}-${current}`}
        ref={(element) => {
          itemRefs.current[current] = element;
        }}
        role="option"
        aria-selected={isSelected}
        className={cn(
          "cursor-pointer px-3 py-1.5 text-sm",
          current === focusedIndex
            ? "bg-accent text-accent-foreground"
            : isSelected
              ? "bg-accent/50"
              : "hover:bg-accent/60",
        )}
        // mousedown, not click: keep focus in the input until the choice lands.
        onMouseDown={(event) => {
          event.preventDefault();
          choose(option);
        }}
        onMouseMove={() => setFocusedIndex(current)}
      >
        {label}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={(next) => (next ? openList() : close())}>
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          className={cn(
            "flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 shadow-xs",
            "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
            disabled && "cursor-not-allowed opacity-50",
            className,
          )}
          onClick={() => {
            if (disabled) return;
            inputRef.current?.focus();
            if (!open) openList();
          }}
        >
          <input
            id={id}
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && options[focusedIndex]
                ? `${listId}-${focusedIndex}`
                : undefined
            }
            autoComplete="off"
            disabled={disabled}
            placeholder={open ? "Type to search accounts…" : placeholder}
            value={open ? search : selectedLabel}
            title={open ? undefined : selectedLabel}
            onChange={(event) => {
              setSearch(event.target.value);
              setFocusedIndex(0);
              if (!open) setOpen(true);
            }}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={handleKeyDown}
            className="min-w-0 flex-1 truncate bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-[max(var(--radix-popover-trigger-width),22rem)] max-w-[calc(100vw-1rem)] p-0"
        // The input keeps focus so typing keeps filtering.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (anchorRef.current?.contains(event.target as Node)) {
            event.preventDefault();
          }
        }}
      >
        <div id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1">
          {clearOption
            ? renderOption(
                clearOption,
                <span className="text-muted-foreground">
                  {clearOption.label}
                </span>,
              )
            : null}
          {groups.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">
              No accounts found
            </p>
          ) : (
            groups.map(([type, list]) => (
              <div key={type} role="group" aria-label={type}>
                <div className="sticky top-0 bg-popover px-3 py-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {type}
                </div>
                {list.map((account) =>
                  renderOption(
                    { kind: "account", key: account.guid, account },
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 break-words">
                        {accountPath(account)}
                      </span>
                      {account.placeholder ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          placeholder
                        </span>
                      ) : null}
                      {account.hidden ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          hidden
                        </span>
                      ) : null}
                    </span>,
                  ),
                )}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
