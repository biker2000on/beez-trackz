"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={(resolvedTheme as ToasterProps["theme"]) ?? "system"}
      className="toaster group"
      position="bottom-right"
      visibleToasts={3}
      offset={{ bottom: "1rem", right: "1rem" }}
      mobileOffset={{
        bottom: "calc(var(--bottom-nav-h) + 1rem)",
        left: "1rem",
        right: "1rem",
      }}
      toastOptions={{
        style: {
          background: "var(--popover)",
          color: "var(--popover-foreground)",
          border: "1px solid var(--border)",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
