"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Flower2, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { ApiError } from "@/lib/api";
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
import { Textarea } from "@/components/ui/textarea";
import { formatDate, todayInput } from "@/features/hives/lib";
import {
  useBloomSpecies,
  useBlooms,
  useCreateBloom,
  useDeleteBloom,
  useEndBloom,
} from "./hooks";

const bloomSchema = z.object({
  species: z.string().trim().min(1, "Species is required"),
  dateFirstSeen: z.string().min(1, "Date is required"),
  abundance: z.string(),
  notes: z.string(),
});

type BloomValues = z.infer<typeof bloomSchema>;

const NOT_RATED = "none";

export function FloraTab({
  apiaryId,
  canEdit = true,
}: {
  apiaryId: string;
  canEdit?: boolean;
}) {
  const active = useBlooms(apiaryId, "active");
  const history = useBlooms(apiaryId, "history");
  const species = useBloomSpecies();
  const createBloom = useCreateBloom();
  const endBloom = useEndBloom();
  const deleteBloom = useDeleteBloom();

  const [speciesFocused, setSpeciesFocused] = React.useState(false);

  const form = useForm<BloomValues>({
    resolver: zodResolver(bloomSchema),
    defaultValues: {
      species: "",
      dateFirstSeen: todayInput(),
      abundance: NOT_RATED,
      notes: "",
    },
  });

  const speciesValue = form.watch("species");
  const abundance = form.watch("abundance");
  const suggestions = React.useMemo(() => {
    const list = species.data ?? [];
    const query = speciesValue.trim().toLowerCase();
    const filtered = query
      ? list.filter((name) => name.toLowerCase().includes(query))
      : list;
    return filtered
      .filter((name) => name.toLowerCase() !== query)
      .slice(0, 6);
  }, [species.data, speciesValue]);

  async function onSubmit(values: BloomValues) {
    try {
      await createBloom.mutateAsync({
        apiaryId,
        species: values.species,
        dateFirstSeen: values.dateFirstSeen,
        abundance:
          values.abundance === NOT_RATED ? null : Number(values.abundance),
        notes: values.notes.trim() === "" ? null : values.notes,
      });
      toast.success("Bloom recorded");
      form.reset({
        species: "",
        dateFirstSeen: todayInput(),
        abundance: NOT_RATED,
        notes: "",
      });
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not record bloom",
      );
    }
  }

  async function onEndBloom(id: string) {
    try {
      await endBloom.mutateAsync(id);
      toast.success("Bloom ended");
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not end bloom",
      );
    }
  }

  async function onDeleteBloom(id: string) {
    try {
      await deleteBloom.mutateAsync(id);
      toast.success("Bloom observation deleted");
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not delete bloom",
      );
    }
  }

  return (
    <div className={`grid gap-4 ${canEdit ? "lg:grid-cols-2" : ""}`}>
      {canEdit ? <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Flower2 className="size-4 text-primary" />
            Record a bloom
          </CardTitle>
          <CardDescription>
            Track what is flowering near this apiary.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="grid gap-4"
            noValidate
          >
            <div className="relative grid gap-2">
              <Label htmlFor="bloom-species">Species</Label>
              <Input
                id="bloom-species"
                placeholder="e.g. Dutch clover"
                autoComplete="off"
                aria-invalid={form.formState.errors.species ? true : undefined}
                {...form.register("species")}
                onFocus={() => setSpeciesFocused(true)}
                onBlur={(event) => {
                  form.register("species").onBlur(event);
                  // Delay so suggestion clicks land before the list hides.
                  setTimeout(() => setSpeciesFocused(false), 150);
                }}
              />
              {speciesFocused && suggestions.length > 0 && (
                <ul className="absolute top-full z-10 mt-1 w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
                  {suggestions.map((name) => (
                    <li key={name}>
                      <button
                        type="button"
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-secondary"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          form.setValue("species", name, {
                            shouldValidate: true,
                          });
                          setSpeciesFocused(false);
                        }}
                      >
                        {name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {form.formState.errors.species && (
                <p className="text-sm text-destructive" role="alert">
                  {form.formState.errors.species.message}
                </p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="bloom-date">First seen</Label>
                <Input
                  id="bloom-date"
                  type="date"
                  aria-invalid={
                    form.formState.errors.dateFirstSeen ? true : undefined
                  }
                  {...form.register("dateFirstSeen")}
                />
                {form.formState.errors.dateFirstSeen && (
                  <p className="text-sm text-destructive" role="alert">
                    {form.formState.errors.dateFirstSeen.message}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label>Abundance</Label>
                <Select
                  value={abundance}
                  onValueChange={(value) => form.setValue("abundance", value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Not rated" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NOT_RATED}>Not rated</SelectItem>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n} — {["Trace", "Light", "Moderate", "Heavy", "Peak"][n - 1]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="bloom-notes">Notes</Label>
              <Textarea id="bloom-notes" rows={2} {...form.register("notes")} />
            </div>
            <Button
              type="submit"
              className="justify-self-start"
              disabled={form.formState.isSubmitting}
            >
              {form.formState.isSubmitting ? "Saving…" : "Record bloom"}
            </Button>
          </form>
        </CardContent>
      </Card> : null}

      <div className="grid content-start gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Active blooms</CardTitle>
          </CardHeader>
          <CardContent>
            {active.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : (active.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing blooming right now.
              </p>
            ) : (
              <ul className="grid gap-2">
                {active.data?.map((bloom) => (
                  <li
                    key={bloom.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{bloom.species}</p>
                      <p className="text-xs text-muted-foreground">
                        Since {formatDate(bloom.dateFirstSeen)}
                        {bloom.abundance != null &&
                          ` · abundance ${bloom.abundance}/5`}
                      </p>
                    </div>
                    {canEdit ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onEndBloom(bloom.id)}
                        disabled={endBloom.isPending}
                      >
                        End bloom
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Bloom history</CardTitle>
          </CardHeader>
          <CardContent>
            {history.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : (history.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                No blooms recorded yet.
              </p>
            ) : (
              <ul className="grid gap-1.5">
                {history.data?.map((bloom) => (
                  <li
                    key={bloom.id}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{bloom.species}</span>
                      <Badge variant="outline">{bloom.year}</Badge>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {formatDate(bloom.dateFirstSeen)}
                        {bloom.dateLastSeen &&
                          ` – ${formatDate(bloom.dateLastSeen)}`}
                      </span>
                      {canEdit ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${bloom.species} observation`}
                          onClick={() => onDeleteBloom(bloom.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
