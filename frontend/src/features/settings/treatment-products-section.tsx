"use client";

import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

import { useTreatmentProducts, useUpdateTreatmentProduct } from "./api";

export function TreatmentProductsSection() {
  const products = useTreatmentProducts();
  const update = useUpdateTreatmentProduct();

  if (products.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (products.isError || !products.data) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load treatment products.
      </p>
    );
  }

  return (
    <div className="grid gap-3" data-config-editor="treatment-withdrawals">
      <p className="text-sm text-muted-foreground">
        A hive is locked from harvest while the treatment is still on, then
        until date-removed plus these days. New events stamp the days at
        record time.
      </p>
      <div className="grid gap-2">
        {products.data.map((product) => (
          <div
            key={product.id}
            className="grid grid-cols-[1fr_5.5rem] items-center gap-3 rounded-md border px-3 py-2"
          >
            <div>
              <p className="text-sm font-medium">{product.name}</p>
              {product.notes && (
                <p className="text-xs text-muted-foreground">{product.notes}</p>
              )}
            </div>
            <Input
              type="number"
              min={0}
              step={1}
              aria-label={`${product.name} withdrawal days`}
              defaultValue={product.withdrawalDays}
              onBlur={(event) => {
                const days = Number(event.target.value);
                if (!Number.isInteger(days) || days < 0) return;
                if (days === product.withdrawalDays) return;
                update.mutate(
                  { id: product.id, withdrawalDays: days },
                  {
                    onSuccess: () => toast.success(`${product.name} updated`),
                    onError: (error) =>
                      toast.error(
                        error instanceof ApiError
                          ? error.message
                          : "Could not save withdrawal days",
                      ),
                  },
                );
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
