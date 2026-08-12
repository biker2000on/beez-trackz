import * as React from "react";

import { cn } from "@/lib/utils";

function localISODate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromInput(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function Input({
  className,
  type,
  onKeyDown,
  ...props
}: React.ComponentProps<"input">) {
  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      type !== "date" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }

    const increment = event.key === "+" || event.key === "=";
    const decrement = event.key === "-";
    const today = event.key === "t" || event.key === "T";
    if (!increment && !decrement && !today) return;

    event.preventDefault();
    const date = today ? new Date() : dateFromInput(event.currentTarget.value);
    if (increment) date.setDate(date.getDate() + 1);
    if (decrement) date.setDate(date.getDate() - 1);
    setNativeInputValue(event.currentTarget, localISODate(date));
  }

  return (
    <input
      type={type}
      data-slot="input"
      data-date-shortcuts={type === "date" ? "true" : undefined}
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
        "placeholder:text-muted-foreground",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/30",
        className,
      )}
      onKeyDown={handleKeyDown}
      {...props}
    />
  );
}

export { Input };
