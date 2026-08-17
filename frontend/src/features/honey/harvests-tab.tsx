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
import { ShortcutForm } from "@/components/ui/shortcut-form";
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

import { ApiError } from "@/lib/api";

import { formatDate, formatLbs, parseNum, todayISO } from "./format";
import {
  useApiaryOptions,
  useCreateHarvest,
  useCreateSession,
  useHarvests,
  useHarvestSessions,
  useHiveOptions,
} from "./hooks";
import { sessionFinalized } from "./session-detail";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

function HarvestLoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="grid justify-items-center gap-3 py-4 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href="/harvest">Back to Honey</Link>
        </Button>
        <Button type="button" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

export function HarvestsTab() {
  const sessions = useHarvestSessions();
  const harvests = useHarvests();
  const [sessionDialogOpen, setSessionDialogOpen] = React.useState(false);
  const [harvestDialogOpen, setHarvestDialogOpen] = React.useState(false);

  // Session entries live on their session's page; listing them here as well
  // double-counted every entry with no marker of where it belonged.
  const standalone = (harvests.data ?? []).filter(
    (harvest) => !harvest.sessionId,
  );

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
          <HarvestLoadError
            message={
              sessions.error instanceof ApiError && sessions.error.status === 403
                ? "Administrator access required"
                : "Could not load sessions."
            }
            onRetry={() => void sessions.refetch()}
          />
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
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Hives</TableHead>
                  <TableHead className="text-right">Calculated</TableHead>
                  <TableHead className="text-right">Extracted</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.data.map((session) => {
                  const finalized = sessionFinalized(
                    session.totalExtractedWeight,
                  );
                  return (
                    <TableRow key={session.id}>
                      <TableCell>{formatDate(session.date)}</TableCell>
                      <TableCell className="font-medium">
                        {session.apiaryName}
                      </TableCell>
                      <TableCell>
                        <Badge variant={finalized ? "secondary" : "accent"}>
                          {finalized ? "Finalized" : "In progress"}
                        </Badge>
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
                  );
                })}
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
          <HarvestLoadError
            message={
              harvests.error instanceof ApiError && harvests.error.status === 403
                ? "Administrator access required"
                : "Could not load harvests."
            }
            onRetry={() => void harvests.refetch()}
          />
        ) : standalone.length === 0 ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            No standalone harvests. Harvests recorded inside a session appear
            on that session&apos;s page.
          </p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Hive</TableHead>
                  <TableHead>Apiary</TableHead>
                  <TableHead className="text-right">Super before</TableHead>
                  <TableHead className="text-right">Super after</TableHead>
                  <TableHead className="text-right">Honey</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {standalone.map((harvest) => (
                  <TableRow key={harvest.id}>
                    <TableCell>{formatDate(harvest.date)}</TableCell>
                    <TableCell className="font-medium">
                      {harvest.hiveName}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {harvest.apiaryName}
                    </TableCell>
                    {harvest.directWeight ? (
                      <TableCell
                        colSpan={2}
                        className="text-right text-xs text-muted-foreground"
                      >
                        Weighed directly
                      </TableCell>
                    ) : (
                      <>
                        <TableCell className="text-right tabular-nums">
                          {formatLbs(harvest.superWeightBefore)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatLbs(harvest.superWeightAfter)}
                        </TableCell>
                      </>
                    )}
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

  const submitSession = (resetAfter: boolean) => form.handleSubmit((values) => {
    mutation.mutate(
      {
        apiaryId: values.apiaryId,
        date: values.date,
        notes: values.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          if (resetAfter) form.reset({ apiaryId: "", date: todayISO(), notes: "" });
          else onOpenChange(false);
        },
      },
    );
  });
  const onSubmit = submitSession(false);

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
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitSession(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
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
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}

// --- new harvest dialog ---

const harvestSchema = z.object({
  hiveId: z.string().min(1, "Hive is required"),
  date: z.string().min(1, "Date is required"),
  superWeightBefore: z.string(),
  superWeightAfter: z.string(),
  harvestedWeight: z.string(),
  notes: z.string(),
});
type HarvestValues = z.infer<typeof harvestSchema>;

const EMPTY_HARVEST: HarvestValues = {
  hiveId: "",
  date: "",
  superWeightBefore: "",
  superWeightAfter: "",
  harvestedWeight: "",
  notes: "",
};

function NewHarvestDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const hives = useHiveOptions();
  const mutation = useCreateHarvest();
  const [mode, setMode] = React.useState<"supers" | "direct">("supers");
  const form = useForm<HarvestValues>({
    resolver: zodResolver(harvestSchema),
    defaultValues: { ...EMPTY_HARVEST, date: todayISO() },
  });

  React.useEffect(() => {
    if (!open) return;
    setMode("supers");
    form.reset({ ...EMPTY_HARVEST, date: todayISO() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const before = parseNum(form.watch("superWeightBefore"));
  const after = parseNum(form.watch("superWeightAfter"));
  const direct = parseNum(form.watch("harvestedWeight"));
  const calculated =
    mode === "direct"
      ? direct
      : before != null && after != null
        ? before - after
        : null;

  const finishHarvest = (resetAfter: boolean) => {
    if (resetAfter) {
      setMode("supers");
      form.reset({ ...EMPTY_HARVEST, date: todayISO() });
    } else {
      onOpenChange(false);
    }
  };
  const submitHarvest = (resetAfter: boolean) => form.handleSubmit((values) => {
    if (mode === "direct") {
      const weight = parseNum(values.harvestedWeight);
      if (weight == null || weight <= 0) {
        form.setError("harvestedWeight", {
          message: "Enter the harvested weight",
        });
        return;
      }
      mutation.mutate(
        {
          hiveId: values.hiveId,
          date: values.date,
          harvestedWeight: weight,
          notes: values.notes.trim() || undefined,
        },
        { onSuccess: () => finishHarvest(resetAfter) },
      );
      return;
    }
    const b = parseNum(values.superWeightBefore);
    const a = parseNum(values.superWeightAfter);
    if (b == null) {
      form.setError("superWeightBefore", {
        message: "Enter the super weight before extraction",
      });
      return;
    }
    if (a == null) {
      form.setError("superWeightAfter", {
        message: "Enter the super weight after extraction",
      });
      return;
    }
    if (b - a < 0) {
      form.setError("superWeightAfter", {
        message: "Super weight before must be greater than after",
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
      { onSuccess: () => finishHarvest(resetAfter) },
    );
  });
  const onSubmit = submitHarvest(false);

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New harvest</DialogTitle>
          <DialogDescription>
            One hive&apos;s harvest, outside a session — weigh the supers or
            the extracted honey directly.
          </DialogDescription>
        </DialogHeader>
        <ShortcutForm
          onSubmit={onSubmit}
          onSubmitAndReset={submitHarvest(true)}
          onEscape={() => onOpenChange(false)}
          className="grid gap-4"
        >
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
          <div
            role="group"
            aria-label="Measurement method"
            className="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-1"
          >
            {(
              [
                ["supers", "Weigh supers"],
                ["direct", "Direct weight"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={
                  mode === value
                    ? "rounded-md bg-card px-3 py-1.5 text-sm font-medium text-foreground shadow-sm"
                    : "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                }
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "supers" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="harvest-before">
                  Super weight before (lbs)
                </Label>
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
                <Label htmlFor="harvest-after">Super weight after (lbs)</Label>
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
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="harvest-weight">Harvested weight (lbs)</Label>
              <Input
                id="harvest-weight"
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0}
                {...form.register("harvestedWeight")}
              />
              <FieldError message={errors.harvestedWeight?.message} />
            </div>
          )}
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
        </ShortcutForm>
      </DialogContent>
    </Dialog>
  );
}
