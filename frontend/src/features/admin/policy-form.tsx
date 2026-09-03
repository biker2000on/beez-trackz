"use client";

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

import {
  OPERATION_POLICY_KEY,
  useOperationPolicy,
  useUpdateOperationPolicy,
  type OperationPolicy,
  type OperationPolicyPayload,
} from "./api";

/**
 * The operation-wide half of the old Preferences accordion (design
 * 2026-09-03 §6.4): thresholds the recommendation engine reads and the flag
 * that turns the yard-visit timer on. One editor, here — the timer itself is
 * Yard's, on `/yard/queue`.
 */
export function OperationPolicyForm() {
  const policy = useOperationPolicy();
  const update = useUpdateOperationPolicy();
  const queryClient = useQueryClient();

  function save(patch: OperationPolicyPayload) {
    const current = policy.data;
    if (!current) return;
    queryClient.setQueryData<OperationPolicy>(OPERATION_POLICY_KEY, {
      ...current,
      ...patch,
      ntfy: current.ntfy,
    });
    update.mutate(patch, {
      onSuccess: () => toast.success("Operation setup saved"),
      onError: (error) => {
        queryClient.setQueryData(OPERATION_POLICY_KEY, current);
        toast.error(
          error instanceof ApiError ? error.message : "Could not save setup",
        );
      },
    });
  }

  function draft(patch: Partial<OperationPolicy>) {
    const current = policy.data;
    if (!current) return;
    queryClient.setQueryData<OperationPolicy>(OPERATION_POLICY_KEY, {
      ...current,
      ...patch,
    });
  }

  if (policy.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (policy.isError || !policy.data) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load the operation policy.{" "}
        <button
          type="button"
          className="font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => policy.refetch()}
        >
          Try again
        </button>
      </p>
    );
  }

  const data = policy.data;

  function numberField(
    id: string,
    label: string,
    value: number | null,
    apply: (value: number | null) => Partial<OperationPolicy>,
    props: { min: string; step: string; max?: string; placeholder: string },
  ) {
    return (
      <div className="grid gap-2">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          type="number"
          min={props.min}
          max={props.max}
          step={props.step}
          placeholder={props.placeholder}
          value={value ?? ""}
          onChange={(event) => {
            const raw = event.target.value.trim();
            draft(apply(raw === "" ? null : Number(raw)));
          }}
          onBlur={(event) => {
            const raw = event.target.value.trim();
            save(apply(raw === "" ? null : Number(raw)));
          }}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2" data-config-editor="thresholds">
      <div className="grid gap-2 sm:col-span-2" id="labor">
        <Label htmlFor="policy-labor">Yard-visit labor minutes</Label>
        <label className="flex items-start gap-3 text-sm">
          <input
            id="policy-labor"
            type="checkbox"
            className="mt-1 size-4 accent-primary"
            checked={data.laborTrackingEnabled}
            onChange={(event) =>
              save({ laborTrackingEnabled: event.target.checked })
            }
          />
          <span>
            Show the start/stop timer on the yard queue. Off by default — this
            is optional, not a scorecard.
          </span>
        </label>
      </div>

      {numberField(
        "policy-mite-100",
        "Varroa wash threshold (per 100)",
        data.miteThresholdPer100,
        (value) => ({ miteThresholdPer100: value }),
        { min: "0.1", step: "0.1", placeholder: "Seasonal default" },
      )}
      {numberField(
        "policy-mite-day",
        "Varroa board threshold (per day)",
        data.miteThresholdPerDay,
        (value) => ({ miteThresholdPerDay: value }),
        { min: "0.1", step: "0.1", placeholder: "9" },
      )}
      {numberField(
        "policy-moisture",
        "Harvest moisture threshold %",
        data.moistureThresholdPct,
        (value) => ({ moistureThresholdPct: value }),
        { min: "0.1", max: "100", step: "0.1", placeholder: "18.6" },
      )}
      {numberField(
        "policy-mite-interval",
        "Mite sample interval (days)",
        data.miteCheckIntervalDays,
        (value) => ({ miteCheckIntervalDays: value }),
        { min: "1", step: "1", placeholder: "Seasonal default" },
      )}
    </div>
  );
}
