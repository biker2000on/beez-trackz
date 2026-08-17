"use client";

import { useEffect } from "react";

import "./globals.css";

export default function GlobalError({
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
    <html lang="en">
      <body className="flex min-h-full flex-col bg-background text-foreground antialiased">
        <div className="grid min-h-dvh flex-1 place-items-center p-6 text-center">
          <div className="grid max-w-sm justify-items-center gap-4">
            <h1 className="text-xl font-semibold tracking-tight">
              Something went wrong
            </h1>
            <p className="text-sm text-muted-foreground">
              Beez Trackz could not load. Retry, or go back to the sign-in
              page.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {retry ? (
                <button
                  type="button"
                  className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
                  onClick={() => retry()}
                >
                  Retry
                </button>
              ) : null}
              <a
                className="inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium"
                href="/login"
              >
                Back to sign in
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
