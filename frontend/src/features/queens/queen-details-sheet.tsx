"use client";

import * as React from "react";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import {
  QUEEN_ORIGIN_LABELS,
  QUEEN_STATUS_LABELS,
  useDeleteQueen,
  type Queen,
} from "./api";
import { markingColorForDate } from "./marking";
import { MarkingDot } from "./queen-node";

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

export function QueenDetailsSheet({
  queen,
  queens,
  onOpenChange,
  onEdit,
}: {
  /** Queen to show; null renders the sheet closed. */
  queen: Queen | null;
  /** All queens, to resolve the parent's display name. */
  queens: Queen[];
  onOpenChange: (open: boolean) => void;
  onEdit: (queen: Queen) => void;
}) {
  const deleteQueen = useDeleteQueen();
  const marking = queen ? markingColorForDate(queen.introducedDate) : null;
  const parent = queen?.parentQueenId
    ? (queens.find((q) => q.id === queen.parentQueenId) ?? null)
    : null;
  const daughters = queen
    ? queens.filter((q) => q.parentQueenId === queen.id)
    : [];

  async function handleDelete() {
    if (!queen) return;
    try {
      await deleteQueen.mutateAsync(queen.id);
      toast.success("Queen deleted");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not delete the queen",
      );
    }
  }

  return (
    <Sheet open={Boolean(queen)} onOpenChange={onOpenChange}>
      <SheetContent>
        {queen && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <MarkingDot date={queen.introducedDate} />
                {marking ? `${marking.year} queen` : "Queen"}
              </SheetTitle>
              <SheetDescription>
                {queen.hiveName
                  ? `${queen.apiaryName ?? "?"} — ${queen.hiveName}`
                  : "Not currently in a hive"}
              </SheetDescription>
            </SheetHeader>
            <div className="grid gap-3">
              <DetailRow label="Status">
                <Badge
                  variant={
                    queen.status === "active"
                      ? "accent"
                      : queen.status === "dead"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {QUEEN_STATUS_LABELS[queen.status] ?? queen.status}
                </Badge>
              </DetailRow>
              <DetailRow label="Origin">
                {QUEEN_ORIGIN_LABELS[queen.origin] ?? queen.origin}
              </DetailRow>
              <DetailRow label="Introduced">
                {formatDate(queen.introducedDate)}
              </DetailRow>
              <DetailRow label="Marking color">
                {marking ? marking.name : "—"}
              </DetailRow>
              <DetailRow label="Parent queen">
                {parent
                  ? (markingColorForDate(parent.introducedDate)
                      ? `${markingColorForDate(parent.introducedDate)?.year} queen`
                      : "Undated queen")
                  : queen.parentQueenId
                    ? "Unknown"
                    : "None"}
              </DetailRow>
              <DetailRow label="Daughters">{daughters.length}</DetailRow>
              {queen.notes && (
                <>
                  <Separator />
                  <div className="grid gap-1.5">
                    <span className="text-sm text-muted-foreground">Notes</span>
                    <p className="whitespace-pre-wrap text-sm">{queen.notes}</p>
                  </div>
                </>
              )}
            </div>
            <SheetFooter>
              <Button onClick={() => onEdit(queen)}>
                <Pencil />
                Edit queen
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" className="text-destructive">
                    <Trash2 />
                    Delete queen
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this queen?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This removes her from the family tree
                      {daughters.length > 0 &&
                        ` and detaches ${daughters.length} daughter ${
                          daughters.length === 1 ? "queen" : "queens"
                        }`}
                      . This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
