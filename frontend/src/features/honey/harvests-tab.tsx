"use client";

/**
 * Harvests tab: harvest sessions (with new-session dialog) and individual
 * per-hive harvests (with new-harvest dialog including a live calculated
 * weight = before − after).
 */

import * as React from "react";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronRight, Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

import { formatDate, formatLbs, parseNum, todayISO } from "./format";
import {
  useApiaryOptions,
  useCreateHarvest,
  useCreateSession,
  useHarvests,
  useHarvestSessions,
  useHiveOptions,
} from "./hooks";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

export function HarvestsTab() {
  const sessions = useHarvestSessions();
  const harvests = useHarvests();
  const [sessionDialogOpen, setSessionDialogOpen] = React.useState(false);
  const [harvestDialogOpen, setHarvestDialogOpen] = React.useState(false);

  return (
    <div className="grid gap-6">
      <section className="grid gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Harvest sessions</h3>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setSessionDialogOpen(true)}
          >
            <Plus />
            New session
          </Button>
        </div>
        {sessions.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : sessions.isError ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Could not load sessions.
          </p>
        ) : sessions.data.length === 0 ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            No sessions yet. A session tracks one extraction day at an apiary.
          </p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Apiary</TableHead>
                  <TableHead className="text-right">Hives</TableHead>
                  <TableHead className="text-right">Calculated</TableHead>
                  <TableHead className="text-right">Extracted</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.data.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>{formatDate(session.date)}</TableCell>
                    <TableCell className="font-medium">
                      {session.apiaryName}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {session.entryCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatLbs(session.calculatedTotal)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {session.totalExtractedWeight != null
                        ? formatLbs(session.totalExtractedWeight)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/harvest/sessions/${session.id}`}>
                          View
                          <ChevronRight />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="grid gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Individual harvests</h3>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setHarvestDialogOpen(true)}
          >
            <Plus />
            New harvest
          </Button>
        </div>
        {harvests.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : harvests.isError ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Could not load harvests.
          </p>
        ) : harvests.data.length === 0 ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            No harvests recorded yet.
          </p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Hive</TableHead>
                  <TableHead>Apiary</TableHead>
                  <TableHead className="text-right">Before</TableHead>
                  <TableHead className="text-right">After</TableHead>
                  <TableHead className="text-right">Honey</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {harvests.data.map((harvest) => (
                  <TableRow key={harvest.id}>
                    <TableCell>{formatDate(harvest.date)}</TableCell>
                    <TableCell className="font-medium">
                      {harvest.hiveName}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {harvest.apiaryName}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatLbs(harvest.superWeightBefore)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatLbs(harvest.superWeightAfter)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatLbs(harvest.calculatedHoneyWeight)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <NewSessionDialog
        open={sessionDialogOpen}
        onOpenChange={setSessionDialogOpen}
      />
      <NewHarvestDialog
        open={harvestDialogOpen}
        onOpenChange={setHarvestDialogOpen}
      />
    </div>
  );
}

// --- new session dialog ---

const sessionSchema = z.object({
  apiaryId: z.string().min(1, "Apiary is required"),
  date: z.string().min(1, "Date is required"),
  notes: z.string(),
});
type SessionValues = z.infer<typeof sessionSchema>;

function NewSessionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const apiaries = useApiaryOptions();
  const mutation = useCreateSession();
  const form = useForm<SessionValues>({
    resolver: zodResolver(sessionSchema),
    defaultValues: { apiaryId: "", date: todayISO(), notes: "" },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({ apiaryId: "", date: todayISO(), notes: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSubmit = form.handleSubmit((values) => {
    mutation.mutate(
      {
        apiaryId: values.apiaryId,
        date: values.date,
        notes: values.notes.trim() || undefined,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  });

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New harvest session</DialogTitle>
          <DialogDescription>
            One extraction day at one apiary — add per-hive weights next.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Apiary</Label>
            <Select
              value={form.watch("apiaryId")}
              onValueChange={(value) =>
                form.setValue("apiaryId", value, { shouldValidate: true })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose an apiary" />
              </SelectTrigger>
              <SelectContent>
                {(apiaries.data ?? []).map((apiary) => (
                  <SelectItem key={apiary.id} value={apiary.id}>
                    {apiary.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.apiaryId?.message} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="session-date">Date</Label>
            <Input id="session-date" type="date" {...form.register("date")} />
            <FieldError message={errors.date?.message} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="session-notes">Notes</Label>
            <Textarea
              id="session-notes"
              rows={2}
              placeholder="Optional notes"
              {...form.register("notes")}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Creating…" : "Create session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- new harvest dialog ---

const harvestSchema = z.object({
  hiveId: z.string().min(1, "Hive is required"),
  date: z.string().min(1, "Date is required"),
  superWeightBefore: z
    .string()
    .refine((v) => parseNum(v) != null, "Enter the weight before extraction"),
  superWeightAfter: z
    .string()
    .refine((v) => parseNum(v) != null, "Enter the weight after extraction"),
  notes: z.string(),
});
type HarvestValues = z.infer<typeof harvestSchema>;

function NewHarvestDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const hives = useHiveOptions();
  const mutation = useCreateHarvest();
  const form = useForm<HarvestValues>({
    resolver: zodResolver(harvestSchema),
    defaultValues: {
      hiveId: "",
      date: todayISO(),
      superWeightBefore: "",
      superWeightAfter: "",
      notes: "",
    },
  });

  React.useEffect(() => {
    if (!open) return;
    form.reset({
      hiveId: "",
      date: todayISO(),
      superWeightBefore: "",
      superWeightAfter: "",
      notes: "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
        date: values.date,
        superWeightBefore: b,
        superWeightAfter: a,
        notes: values.notes.trim() || undefined,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  });

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New harvest</DialogTitle>
          <DialogDescription>
            Super weights before and after extraction for one hive.
          </DialogDescription>
        </DialogHeader>
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
                {(hives.data ?? []).map((hive) => (
                  <SelectItem key={hive.id} value={hive.id}>
                    {hive.positionLabel} — {hive.apiaryName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.hiveId?.message} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="harvest-date">Date</Label>
            <Input id="harvest-date" type="date" {...form.register("date")} />
            <FieldError message={errors.date?.message} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="harvest-before">Weight before (lbs)</Label>
              <Input
                id="harvest-before"
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0}
                {...form.register("superWeightBefore")}
              />
              <FieldError message={errors.superWeightBefore?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="harvest-after">Weight after (lbs)</Label>
              <Input
                id="harvest-after"
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
            <Label htmlFor="harvest-notes">Notes</Label>
            <Textarea
              id="harvest-notes"
              rows={2}
              placeholder="Optional notes"
              {...form.register("notes")}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Record harvest"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
