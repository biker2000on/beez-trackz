"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ShortcutDef } from "./shortcut-provider";

function Keys({ keys }: { keys: string }) {
  return (
    <span className="flex gap-1">
      {keys.split(" ").map((k, i) => (
        <kbd
          key={i}
          className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1.5 font-mono text-[11px] font-medium"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function ShortcutsHelpDialog({
  open,
  onOpenChange,
  navShortcuts,
  pageShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navShortcuts: Array<{ keys: string; description: string }>;
  pageShortcuts: ShortcutDef[];
}) {
  const groups = new Map<string, Array<{ keys: string; description: string }>>();
  groups.set("Navigation", navShortcuts);
  for (const s of pageShortcuts) {
    const list = groups.get(s.group) ?? [];
    list.push(s);
    groups.set(s.group, list);
  }
  groups.set("General", [
    { keys: "?", description: "Show or hide this help" },
    { keys: "Escape", description: "Close dialogs" },
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts work anywhere outside a text field. Page shortcuts appear
            when the page is open.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {[...groups.entries()].map(([group, shortcuts]) => (
            <div key={group}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                {group}
              </h3>
              <ul className="space-y-1">
                {shortcuts.map((s) => (
                  <li
                    key={s.keys}
                    className="flex items-center justify-between text-sm py-0.5"
                  >
                    <span>{s.description}</span>
                    <Keys keys={s.keys} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
