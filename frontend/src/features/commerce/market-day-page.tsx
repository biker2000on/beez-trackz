"use client";

/**
 * Market day: a full-screen, phone-first point of sale.
 *
 * It used to be a tab inside the honey hub, where one stray tab click threw
 * away a cart mid-sale. It now owns the whole viewport with its own chrome:
 * the only way out is the Exit control, and that asks for confirmation while
 * a cart has jars in it (a page reload is guarded too).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { ShoppingBasket, X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { MarketDayTab } from "./market-day-tab";

export function MarketDayPage() {
  const router = useRouter();
  const [cartCount, setCartCount] = React.useState(0);
  const [confirmExit, setConfirmExit] = React.useState(false);

  const onCartCountChange = React.useCallback(
    (count: number) => setCartCount(count),
    [],
  );

  // A reload or a closed tab loses the cart too; warn the same way.
  React.useEffect(() => {
    if (cartCount === 0) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [cartCount]);

  function exit() {
    if (cartCount > 0) setConfirmExit(true);
    else router.push("/harvest");
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-background">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <ShoppingBasket className="size-5 shrink-0 text-primary" />
          <h1 className="truncate text-lg font-bold tracking-tight">
            Market day
          </h1>
          {cartCount > 0 && (
            <Badge variant="accent">
              {cartCount} {cartCount === 1 ? "jar" : "jars"} in cart
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={exit}>
          <X />
          Exit
        </Button>
      </header>

      <div className="flex-1 px-4 py-5 pb-24 md:px-8">
        <MarketDayTab onCartCountChange={onCartCountChange} />
      </div>

      <AlertDialog open={confirmExit} onOpenChange={setConfirmExit}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave market day?</AlertDialogTitle>
            <AlertDialogDescription>
              The current sale has {cartCount} {cartCount === 1 ? "jar" : "jars"}{" "}
              in the cart. Leaving discards it — nothing is recorded until you
              complete the sale.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => router.push("/harvest")}
            >
              Discard and exit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
