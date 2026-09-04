"use client";

import { useEffect } from "react";
import Link from "next/link";

import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  unstable_retry?: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const retry = unstable_retry ?? reset;

  return (
    <div className="grid min-h-64 flex-1 place-items-center p-6 text-center">
      <div className="grid max-w-sm justify-items-center gap-4">
        <LogoMark className="size-12" />
        <div className="grid gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            Something went wrong
          </h1>
          <p className="text-sm text-muted-foreground">
            This page hit an unexpected error. You can try again, or go back
            to Today.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {retry ? (
            <Button type="button" onClick={() => retry()}>
              Retry
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link href="/today">Back to Today</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
