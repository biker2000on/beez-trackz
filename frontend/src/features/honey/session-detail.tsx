"use client";

/**
 * Harvest session detail (/harvest/sessions/[id]): calculated vs actual
 * extraction summary cards, per-hive entries with delete, an add-entry form
 * with a live calculated-weight badge, and the true-up form.
 */

import * as React from "react";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, Plus, Scale, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { formatDate, formatLbs, parseNum } from "./format";
import {
  useAddSessionEntry,
  useApiaryOptions,
  useDeleteSessionEntry,
  useHarvestSession,
  useHiveOptions,
  useTrueUpSession,
} from "./hooks";
import type { HarvestSessionEntry } from "./types";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

export function SessionDetail({ id }: { id: string }) {
  const session = useHarvestSession(id);
  const apiaries = useApiaryOptions();
  const deleteEntry = useDeleteSessionEntry();
  const [confirmEntry, setConfirmEntry] =
    React.useState<HarvestSessionEntry | null>(null);

  if (session.isPending) {
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (session.isError) {
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-4">
        <BackLink />
        <p className="py-8 text-center text-sm text-muted-foreground">
          Could not load this harvest session. It may have been deleted.
        </p>
      </div>
    );
  }

  const data = session.data;
  const apiaryName =
    apiaries.data?.find((apiary) => apiary.id === data.apiaryId)?.name ?? null;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <div className="grid gap-1">
        <BackLink />
        <h1 className="text-2xl font-bold tracking-tight">
          Harvest session · {formatDate(data.date)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {apiaryName ?? "Apiary"}
          {data.notes ? ` — ${data.notes}` : ""}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard
          label="Calculated total"
          value={formatLbs(data.calculatedTotal)}
          sub={`${data.entries.length} hive ${data.entries.length === 1 ? "entry" : "entries"}`}
        />
        <SummaryCard
          label="Actual extracted"
          value={
            data.totalExtractedWeight != null
              ? formatLbs(data.totalExtractedWeight)
              : "—"
          }
          sub={
            data.totalExtractedWeight != null
              ? "From true-up"
              : "Record after bottling"
          }
        />
        <SummaryCard
          label="Difference"
          value={
            data.difference != null
              ? `${data.difference > 0 ? "+" : ""}${formatLbs(data.difference)}`
              : "—"
          }
          sub="Calculated − extracted"
          valueClass={cn(
            data.difference != null && data.difference > 0 && "text-amber-600 dark:text-amber-400",
            data.difference != null && data.difference < 0 && "text-green-700 dark:text-green-400",
          )}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Hive entries</CardTitle>
          <CardDescription>
            Super weights per hive; honey = before − after.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.entries.length === 0 ? (
            <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
              No entries yet. Add the first hive below.
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hive</TableHead>
                    <TableHead className="text-right">Before</TableHead>
                    <TableHead className="text-right">After</TableHead>
                    <TableHead className="text-right">Honey</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">
                        {entry.hiveName}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatLbs(entry.superWeightBefore)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatLbs(entry.superWeightAfter)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatLbs(entry.calculatedHoneyWeight)}
                      </TableCell>
                      <TableCell className="max-w-48 truncate text-muted-foreground">
                        {entry.notes ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Delete entry for ${entry.hiveName}`}
                          onClick={() => setConfirmEntry(entry)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <AddEntryCard sessionId={id} apiaryId={data.apiaryId} />
        <TrueUpCard
          sessionId={id}
          currentWeight={data.totalExtractedWeight}
          calculatedTotal={data.calculatedTotal}
        />
      </div>

      <AlertDialog
        open={confirmEntry !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmEntry(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmEntry
                ? `The ${formatLbs(confirmEntry.calculatedHoneyWeight)} entry for ${confirmEntry.hiveName} will be removed from this session.`
                : ""}{" "}
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmEntry) deleteEntry.mutate(confirmEntry.id);
                setConfirmEntry(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/harvest/harvests"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Harvests
    </Link>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub: string;
  valueClass?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className={cn("mt-1 text-2xl font-bold tabular-nums", valueClass)}>
          {value}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

// --- add entry ---

const entrySchema = z.object({
  hiveId: z.string().min(1, "Hive is required"),
  superWeightBefore: z
    .string()
    .refine((v) => parseNum(v) != null, "Enter the weight before extraction"),
  superWeightAfter: z
    .string()
    .refine((v) => parseNum(v) != null, "Enter the weight after extraction"),
  notes: z.string(),
});
type EntryValues = z.infer<typeof entrySchema>;

function AddEntryCard({
  sessionId,
  apiaryId,
}: {
  sessionId: string;
  apiaryId: string;
}) {
  const hives = useHiveOptions();
  const mutation = useAddSessionEntry(sessionId);
  const form = useForm<EntryValues>({
    resolver: zodResolver(entrySchema),
    defaultValues: {
      hiveId: "",
      superWeightBefore: "",
      superWeightAfter: "",
      notes: "",
    },
  });

  // Prefer hives from the session's apiary; fall back to all hives.
  const apiaryHives = (hives.data ?? []).filter(
    (hive) => hive.apiaryId === apiaryId,
  );
  const options = apiaryHives.length > 0 ? apiaryHives : (hives.data ?? []);

  const before = parseNum(form.watch("superWeightBefore"));
  const after = parseNum(form.watch("superWeightAfter"));
  const calculated = before != null && after != null ? before - after : null;

  const onSubmit = form.handleSubmit((values) => {
    const b = parseNum(values.superWeightBefore)!;
    const a = parseNum(values.superWeightAfter)!;
    if (b - a < 0) {
      form.setError("superWeightAfter", {
        message: "Weight before must be greater than weight after",
      });
      return;
    }
    mutation.mutate(
      {
        hiveId: values.hiveId,
        superWeightBefore: b,
        superWeightAfter: a,
        notes: values.notes.trim() || undefined,
      },
      {
        onSuccess: () =>
          form.reset({
            hiveId: "",
            superWeightBefore: "",
            superWeightAfter: "",
            notes: "",
          }),
      },
    );
  });

  const { errors } = form.formState;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add hive entry</CardTitle>
        <CardDescription>
          Weigh the supers before and after extraction.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Hive</Label>
            <Select
              value={form.watch("hiveId")}
              onValueChange={(value) =>
                form.setValue("hiveId", value, { shouldValidate: true })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a hive" />
              </SelectTrigger>
              <SelectContent>
                {options.map((hive) => (
                  <SelectItem key={hive.id} value={hive.id}>
                    {hive.positionLabel} — {hive.apiaryName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.hiveId?.message} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="entry-before">Before (lbs)</Label>
              <Input
                id="entry-before"
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0}
                {...form.register("superWeightBefore")}
              />
              <FieldError message={errors.superWeightBefore?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="entry-after">After (lbs)</Label>
              <Input
                id="entry-after"
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0}
                {...form.register("superWeightAfter")}
              />
              <FieldError message={errors.superWeightAfter?.message} />
            </div>
          </div>
          {calculated != null && (
            <Badge
              variant={calculated < 0 ? "destructive" : "accent"}
              className="justify-self-start tabular-nums"
            >
              Honey: {formatLbs(calculated)}
            </Badge>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="entry-notes">Notes</Label>
            <Input
              id="entry-notes"
              placeholder="Optional notes"
              {...form.register("notes")}
            />
          </div>
          <Button
            type="submit"
            className="justify-self-start"
            disabled={mutation.isPending}
          >
            <Plus />
            {mutation.isPending ? "Adding…" : "Add entry"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// --- true-up ---

const trueUpSchema = z.object({
  totalExtractedWeight: z
    .string()
    .refine((v) => parseNum(v) != null, "Enter the extracted weight"),
});
type TrueUpValues = z.infer<typeof trueUpSchema>;

function TrueUpCard({
  sessionId,
  currentWeight,
  calculatedTotal,
}: {
  sessionId: string;
  currentWeight: number | null;
  calculatedTotal: number;
}) {
  const mutation = useTrueUpSession(sessionId);
  const form = useForm<TrueUpValues>({
    resolver: zodResolver(trueUpSchema),
    defaultValues: {
      totalExtractedWeight: currentWeight != null ? String(currentWeight) : "",
    },
  });

  React.useEffect(() => {
    form.reset({
      totalExtractedWeight: currentWeight != null ? String(currentWeight) : "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWeight]);

  const entered = parseNum(form.watch("totalExtractedWeight"));
  const liveDifference = entered != null ? calculatedTotal - entered : null;

  const onSubmit = form.handleSubmit((values) => {
    mutation.mutate(parseNum(values.totalExtractedWeight)!);
  });

  const { errors } = form.formState;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="size-4 text-primary" />
          True-up
        </CardTitle>
        <CardDescription>
          After bottling, record the actual total weight extracted.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="true-up-weight">Total extracted (lbs)</Label>
            <Input
              id="true-up-weight"
              type="number"
              inputMode="decimal"
              step="0.1"
              min={0}
              {...form.register("totalExtractedWeight")}
            />
            <FieldError message={errors.totalExtractedWeight?.message} />
          </div>
          {liveDifference != null && (
            <p className="text-xs text-muted-foreground">
              Difference vs calculated:{" "}
              <span className="font-medium tabular-nums">
                {liveDifference > 0 ? "+" : ""}
                {formatLbs(liveDifference)}
              </span>
            </p>
          )}
          <Button
            type="submit"
            className="justify-self-start"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Saving…" : "Save extracted weight"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
