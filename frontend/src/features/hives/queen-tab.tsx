"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Crown, Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  useCreateQueen,
  useHiveQueens,
  useQueens,
  type Queen,
} from "./hooks";
import { formatDate, parseApiDate, queenYearColor, todayInput } from "./lib";

const QUEEN_ORIGINS = [
  ["purchased", "Purchased"],
  ["swarm", "Swarm"],
  ["raised", "Raised"],
  ["walked", "Walked"],
  ["emergency_cell", "Emergency cell"],
  ["unknown", "Unknown"],
] as const;

const QUEEN_STATUSES = [
  ["active", "Active"],
  ["superseded", "Superseded"],
  ["dead", "Dead"],
  ["missing", "Missing"],
] as const;

function queenStatusLabel(status: string): string {
  return QUEEN_STATUSES.find(([value]) => value === status)?.[1] ?? status;
}

function queenOriginLabel(origin: string): string {
  return QUEEN_ORIGINS.find(([value]) => value === origin)?.[1] ?? origin;
}

/** International year-marking color dot for a queen's introduced year. */
function YearDot({ introducedDate }: { introducedDate: string | null }) {
  if (!introducedDate) return null;
  const year = parseApiDate(introducedDate).getFullYear();
  if (Number.isNaN(year)) return null;
  const color = queenYearColor(year);
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      title={`${year} marking color: ${color.name}`}
    >
      <span className={cn("size-3 rounded-full", color.className)} />
      {year}
    </span>
  );
}

function QueenCard({ queen, current }: { queen: Queen; current?: boolean }) {
  return (
    <Card className={cn(current && "border-primary/50")}>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Crown className="size-4 text-primary" />
          {current ? "Current queen" : queenOriginLabel(queen.origin)}
          <YearDot introducedDate={queen.introducedDate} />
        </CardTitle>
        <Badge variant={queen.status === "active" ? "accent" : "secondary"}>
          {queenStatusLabel(queen.status)}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-1 text-sm text-muted-foreground">
        <p>
          Origin: {queenOriginLabel(queen.origin)}
          {queen.introducedDate &&
            ` · introduced ${formatDate(queen.introducedDate)}`}
        </p>
        {queen.notes && <p className="whitespace-pre-wrap">{queen.notes}</p>}
      </CardContent>
    </Card>
  );
}

const queenSchema = z.object({
  origin: z.string().min(1, "Origin is required"),
  parentQueenId: z.string(),
  introducedDate: z.string(),
  status: z.string(),
  notes: z.string(),
});

type QueenValues = z.infer<typeof queenSchema>;

const NO_PARENT = "none";

export function QueenTab({ hiveId }: { hiveId: string }) {
  const queens = useHiveQueens(hiveId);
  const allQueens = useQueens();
  const createQueen = useCreateQueen();
  const [addOpen, setAddOpen] = React.useState(false);

  const form = useForm<QueenValues>({
    resolver: zodResolver(queenSchema),
    defaultValues: {
      origin: "purchased",
      parentQueenId: NO_PARENT,
      introducedDate: todayInput(),
      status: "active",
      notes: "",
    },
  });

  React.useEffect(() => {
    if (addOpen) {
      form.reset({
        origin: "purchased",
        parentQueenId: NO_PARENT,
        introducedDate: todayInput(),
        status: "active",
        notes: "",
      });
    }
  }, [addOpen, form]);

  const watched = form.watch();

  const list = queens.data ?? [];
  const current =
    list.find((queen) => queen.status === "active") ?? null;
  const past = list.filter((queen) => queen !== current);

  async function onSubmit(values: QueenValues) {
    try {
      await createQueen.mutateAsync({
        hiveId,
        origin: values.origin,
        parentQueenId:
          values.parentQueenId === NO_PARENT ? null : values.parentQueenId,
        introducedDate:
          values.introducedDate === "" ? null : values.introducedDate,
        status: values.status,
        notes: values.notes.trim() === "" ? null : values.notes,
      });
      toast.success("Queen added");
      setAddOpen(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not add the queen",
      );
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          Add queen
        </Button>
      </div>

      {queens.isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No queens recorded for this hive.
        </p>
      ) : (
        <div className="grid gap-4">
          {current && <QueenCard queen={current} current />}
          {past.length > 0 && (
            <div className="grid gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Past queens
              </h3>
              <div className="grid gap-3">
                {past.map((queen) => (
                  <QueenCard key={queen.id} queen={queen} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add queen</DialogTitle>
            <DialogDescription>
              Record a new queen for this hive.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="grid gap-4"
            noValidate
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Origin</Label>
                <Select
                  value={watched.origin}
                  onValueChange={(value) =>
                    form.setValue("origin", value, { shouldValidate: true })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUEEN_ORIGINS.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Status</Label>
                <Select
                  value={watched.status}
                  onValueChange={(value) => form.setValue("status", value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUEEN_STATUSES.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="queen-introduced">Introduced</Label>
              <Input
                id="queen-introduced"
                type="date"
                {...form.register("introducedDate")}
              />
            </div>
            <div className="grid gap-2">
              <Label>Parent queen</Label>
              <Select
                value={watched.parentQueenId}
                onValueChange={(value) =>
                  form.setValue("parentQueenId", value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PARENT}>No parent</SelectItem>
                  {allQueens.data?.map((queen) => (
                    <SelectItem key={queen.id} value={queen.id}>
                      {queen.hiveName ?? "Unassigned"}
                      {queen.introducedDate
                        ? ` (${formatDate(queen.introducedDate)})`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="queen-notes">Notes</Label>
              <Textarea
                id="queen-notes"
                rows={2}
                {...form.register("notes")}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setAddOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Saving…" : "Add queen"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
