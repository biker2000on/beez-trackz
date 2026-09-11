"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EquipmentAction } from "./api";

interface StockOption {
  itemId: string;
  itemName: string;
  locationId: string;
  locationName: string;
  condition: string | null;
  hiveId: string | null;
  unit: string;
  available: string;
  countKnown: boolean;
}
interface Deployment {
  id: string;
  typeName: string;
  outstanding: number;
}

export function EquipmentReview({
  apiaryId,
  hiveId,
  value,
  onChange,
  disabled,
}: {
  apiaryId: string;
  hiveId: string;
  value: EquipmentAction[];
  onChange: (value: EquipmentAction[]) => void;
  disabled?: boolean;
}) {
  const stock = useQuery({
    queryKey: ["stock", "visit", apiaryId],
    queryFn: () =>
      api.get<{ rows: StockOption[] }>("/stock", {
        params: {
          kind: "equipment",
          apiaryId,
          condition: "serviceable",
          hiveId: "null",
        },
      }),
    enabled: Boolean(apiaryId && hiveId),
  });
  const deployments = useQuery({
    queryKey: ["equipment", "deployments", "hive", hiveId],
    queryFn: () => api.get<Deployment[]>(`/hives/${hiveId}/deployments`),
    enabled: Boolean(hiveId),
  });
  const options =
    stock.data?.rows.filter(
      (row) => row.countKnown && Number(row.available) > 0 && !row.hiveId,
    ) ?? [];
  const update = (index: number, patch: Partial<EquipmentAction>) =>
    onChange(
      value.map((action, i) =>
        i === index ? { ...action, ...patch } : action,
      ),
    );
  return (
    <fieldset disabled={disabled} className="grid gap-3 rounded-xl border p-4">
      <legend className="px-1 text-sm font-semibold">
        Equipment used in this visit
      </legend>
      <p className="text-sm text-muted-foreground">
        Only checked actions move stock when you confirm. Spoken plans stay
        observations until you accept them.
      </p>
      {(stock.isError || deployments.isError) && (
        <p role="alert" className="text-sm text-destructive">
          Equipment could not be loaded.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => {
              void stock.refetch();
              void deployments.refetch();
            }}
          >
            Retry
          </button>
        </p>
      )}
      {value.map((action, index) => (
        <div key={index} className="grid gap-3 rounded-lg bg-secondary/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <Label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={action.accepted}
                onChange={(e) => update(index, { accepted: e.target.checked })}
              />
              Apply this equipment change
            </Label>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove equipment change ${index + 1}`}
              onClick={() => onChange(value.filter((_, i) => index !== i))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          {action.description && (
            <p className="text-sm">Heard: {action.description}</p>
          )}
          <div className="grid gap-3 sm:grid-cols-[1fr_2fr_90px]">
            <Label className="grid gap-1">
              Action
              <select
                className="min-h-11 rounded-md border bg-background px-2 text-base"
                value={action.kind}
                onChange={(e) =>
                  update(index, {
                    kind: e.target.value as EquipmentAction["kind"],
                    referenceId: "",
                    sourceLocationId: undefined,
                    accepted: false,
                  })
                }
              >
                <option value="deploy">Install on hive</option>
                <option value="return">Return to storage</option>
              </select>
            </Label>
            <Label className="grid gap-1">
              {action.kind === "deploy"
                ? "Available equipment"
                : "Installed equipment"}
              <select
                className="min-h-11 min-w-0 rounded-md border bg-background px-2 text-base"
                value={
                  action.kind === "deploy"
                    ? `${action.referenceId}|${action.sourceLocationId ?? ""}`
                    : action.referenceId
                }
                onChange={(e) => {
                  const [referenceId, sourceLocationId] =
                    e.target.value.split("|");
                  update(index, { referenceId, sourceLocationId });
                }}
              >
                <option value={action.kind === "deploy" ? "|" : ""}>
                  Select equipment
                </option>
                {action.kind === "deploy"
                  ? options.map((row) => (
                      <option
                        key={`${row.itemId}-${row.locationId}`}
                        value={`${row.itemId}|${row.locationId}`}
                      >
                        {row.itemName} · {row.available} {row.unit} ·{" "}
                        {row.locationName}
                      </option>
                    ))
                  : deployments.data
                      ?.filter((row) => row.outstanding > 0)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.typeName} · {row.outstanding} installed
                        </option>
                      ))}
              </select>
            </Label>
            <Label className="grid gap-1">
              Quantity
              <Input
                type="number"
                min={1}
                step={1}
                value={action.quantity}
                onChange={(e) =>
                  update(index, { quantity: Number(e.target.value) })
                }
              />
            </Label>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="justify-self-start"
        disabled={!hiveId}
        onClick={() =>
          onChange([
            ...value,
            { kind: "deploy", referenceId: "", quantity: 1, accepted: false },
          ])
        }
      >
        <Plus className="size-4" />
        Add equipment change
      </Button>
      {!hiveId && (
        <p className="text-sm text-muted-foreground">
          Choose a hive before assigning equipment.
        </p>
      )}
    </fieldset>
  );
}
