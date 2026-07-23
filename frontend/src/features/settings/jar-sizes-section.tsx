"use client";

import * as React from "react";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  useCreateJarSize,
  useJarSizes,
  useUpdateJarSize,
  type JarSize,
} from "./api";

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberToInput(value: number | null): string {
  return value === null ? "" : String(value);
}

function JarSizeRow({ jar }: { jar: JarSize }) {
  const updateJar = useUpdateJarSize();
  const [label, setLabel] = React.useState(jar.label);
  const [honeyOz, setHoneyOz] = React.useState(numberToInput(jar.honeyOz));
  const [price, setPrice] = React.useState(numberToInput(jar.defaultPrice));

  // Re-sync the inline draft when the server row changes underneath it
  // (render-time state adjustment keyed on the previous server values).
  const [prevServer, setPrevServer] = React.useState({
    label: jar.label,
    honeyOz: jar.honeyOz,
    defaultPrice: jar.defaultPrice,
  });
  if (
    prevServer.label !== jar.label ||
    prevServer.honeyOz !== jar.honeyOz ||
    prevServer.defaultPrice !== jar.defaultPrice
  ) {
    setPrevServer({
      label: jar.label,
      honeyOz: jar.honeyOz,
      defaultPrice: jar.defaultPrice,
    });
    setLabel(jar.label);
    setHoneyOz(numberToInput(jar.honeyOz));
    setPrice(numberToInput(jar.defaultPrice));
  }

  const dirty =
    label.trim() !== jar.label ||
    parseNumber(honeyOz) !== jar.honeyOz ||
    parseNumber(price) !== jar.defaultPrice;

  async function handleSave() {
    if (label.trim() === "") {
      toast.error("Label is required");
      return;
    }
    try {
      await updateJar.mutateAsync({
        id: jar.id,
        label: label.trim(),
        honeyOz: parseNumber(honeyOz),
        defaultPrice: parseNumber(price),
      });
      toast.success(`Saved "${label.trim()}"`);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not save jar size",
      );
    }
  }

  async function handleActiveToggle(checked: boolean) {
    try {
      await updateJar.mutateAsync({ id: jar.id, isActive: checked });
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not update jar size",
      );
    }
  }

  return (
    <TableRow className={jar.isActive ? undefined : "opacity-60"}>
      <TableCell>
        <Input
          aria-label={`Label for ${jar.label}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </TableCell>
      <TableCell>
        <Input
          aria-label={`Honey ounces for ${jar.label}`}
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          className="w-24"
          value={honeyOz}
          onChange={(e) => setHoneyOz(e.target.value)}
        />
      </TableCell>
      <TableCell>
        <Input
          aria-label={`Default price for ${jar.label}`}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          className="w-24"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </TableCell>
      <TableCell className="text-center">
        <Checkbox
          aria-label={`${jar.label} active`}
          checked={jar.isActive}
          disabled={updateJar.isPending}
          onCheckedChange={(checked) => handleActiveToggle(checked === true)}
        />
      </TableCell>
      <TableCell>
        <Button
          size="icon-sm"
          variant={dirty ? "default" : "ghost"}
          aria-label={`Save ${jar.label}`}
          disabled={!dirty || updateJar.isPending}
          onClick={handleSave}
        >
          <Check />
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function JarSizesSection() {
  const jarSizes = useJarSizes();
  const createJar = useCreateJarSize();
  const [newLabel, setNewLabel] = React.useState("");
  const [newHoneyOz, setNewHoneyOz] = React.useState("");
  const [newPrice, setNewPrice] = React.useState("");

  async function handleAdd() {
    if (newLabel.trim() === "") {
      toast.error("Label is required");
      return;
    }
    try {
      await createJar.mutateAsync({
        label: newLabel.trim(),
        honeyOz: parseNumber(newHoneyOz),
        defaultPrice: parseNumber(newPrice),
      });
      toast.success(`Added "${newLabel.trim()}"`);
      setNewLabel("");
      setNewHoneyOz("");
      setNewPrice("");
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Could not add jar size",
      );
    }
  }

  if (jarSizes.isLoading) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (jarSizes.isError) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load jar sizes.{" "}
        <button
          type="button"
          className="font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => jarSizes.refetch()}
        >
          Try again
        </button>
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Label</TableHead>
          <TableHead>Honey (oz)</TableHead>
          <TableHead>Default price ($)</TableHead>
          <TableHead className="text-center">Active</TableHead>
          <TableHead className="w-12" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {(jarSizes.data ?? []).map((jar) => (
          <JarSizeRow key={jar.id} jar={jar} />
        ))}
        <TableRow>
          <TableCell>
            <Input
              aria-label="New jar size label"
              placeholder="New size…"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </TableCell>
          <TableCell>
            <Input
              aria-label="New jar size honey ounces"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              className="w-24"
              placeholder="oz"
              value={newHoneyOz}
              onChange={(e) => setNewHoneyOz(e.target.value)}
            />
          </TableCell>
          <TableCell>
            <Input
              aria-label="New jar size default price"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              className="w-24"
              placeholder="$"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
            />
          </TableCell>
          <TableCell />
          <TableCell>
            <Button
              size="icon-sm"
              aria-label="Add jar size"
              disabled={createJar.isPending || newLabel.trim() === ""}
              onClick={handleAdd}
            >
              <Plus />
            </Button>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}
