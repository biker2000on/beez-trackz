"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Check, EyeOff, Eye } from "lucide-react";
import {
  createJarSize,
  updateJarSize,
  type JarSizeRecord,
} from "@/actions/jar-sizes";

export function JarSizeSettings({ initialSizes }: { initialSizes: JarSizeRecord[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Per-row draft edits keyed by id
  const [drafts, setDrafts] = useState<
    Record<string, { label: string; honeyOz: string; defaultPrice: string }>
  >(
    Object.fromEntries(
      initialSizes.map((s) => [
        s.id,
        {
          label: s.label,
          honeyOz: s.honeyOz != null ? String(s.honeyOz) : "",
          defaultPrice: s.defaultPrice != null ? String(s.defaultPrice) : "",
        },
      ])
    )
  );
  const [newRow, setNewRow] = useState({ label: "", honeyOz: "", defaultPrice: "" });

  const isDirty = (s: JarSizeRecord) => {
    const d = drafts[s.id];
    if (!d) return false;
    return (
      d.label !== s.label ||
      d.honeyOz !== (s.honeyOz != null ? String(s.honeyOz) : "") ||
      d.defaultPrice !== (s.defaultPrice != null ? String(s.defaultPrice) : "")
    );
  };

  const saveRow = (s: JarSizeRecord) => {
    const d = drafts[s.id];
    startTransition(async () => {
      const result = await updateJarSize(s.id, {
        label: d.label,
        honeyOz: d.honeyOz === "" ? null : parseFloat(d.honeyOz),
        defaultPrice: d.defaultPrice === "" ? null : parseFloat(d.defaultPrice),
      });
      if (result && "error" in result && result.error) setError(String(result.error));
      else router.refresh();
    });
  };

  const addRow = () => {
    setError(null);
    startTransition(async () => {
      const result = await createJarSize({
        label: newRow.label,
        honeyOz: newRow.honeyOz === "" ? null : parseFloat(newRow.honeyOz),
        defaultPrice: newRow.defaultPrice === "" ? null : parseFloat(newRow.defaultPrice),
      });
      if (result?.error) {
        setError(result.error);
        return;
      }
      setNewRow({ label: "", honeyOz: "", defaultPrice: "" });
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Container sizes</CardTitle>
        <CardDescription>
          Sizes appear in jarring, sales, and inventory. The honey weight per
          container keeps the bulk ledger accurate; the default price prefills
          sales.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead className="w-28 text-right">Honey (oz)</TableHead>
                <TableHead className="w-28 text-right">Price ($)</TableHead>
                <TableHead className="w-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initialSizes.map((s) => {
                const d = drafts[s.id];
                return (
                  <TableRow key={s.id} className={s.isActive ? "" : "opacity-50"}>
                    <TableCell>
                      <Input
                        value={d?.label ?? s.label}
                        className="h-9"
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [s.id]: { ...prev[s.id], label: e.target.value },
                          }))
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        inputMode="decimal"
                        className="h-9 text-right tabular-nums"
                        value={d?.honeyOz ?? ""}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [s.id]: { ...prev[s.id], honeyOz: e.target.value },
                          }))
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        className="h-9 text-right tabular-nums"
                        value={d?.defaultPrice ?? ""}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [s.id]: { ...prev[s.id], defaultPrice: e.target.value },
                          }))
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 justify-end">
                        {isDirty(s) && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-green-600"
                            disabled={pending}
                            onClick={() => saveRow(s)}
                            title="Save"
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground"
                          disabled={pending}
                          title={s.isActive ? "Hide from pickers" : "Restore"}
                          onClick={() =>
                            startTransition(async () => {
                              await updateJarSize(s.id, { isActive: !s.isActive });
                              router.refresh();
                            })
                          }
                        >
                          {s.isActive ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {/* New row */}
              <TableRow>
                <TableCell>
                  <Input
                    placeholder="New size label"
                    className="h-9"
                    value={newRow.label}
                    onChange={(e) => setNewRow({ ...newRow, label: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    inputMode="decimal"
                    placeholder="oz"
                    className="h-9 text-right tabular-nums"
                    value={newRow.honeyOz}
                    onChange={(e) => setNewRow({ ...newRow, honeyOz: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    placeholder="$"
                    className="h-9 text-right tabular-nums"
                    value={newRow.defaultPrice}
                    onChange={(e) => setNewRow({ ...newRow, defaultPrice: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    disabled={pending || !newRow.label.trim()}
                    onClick={addRow}
                    className="gap-1"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
