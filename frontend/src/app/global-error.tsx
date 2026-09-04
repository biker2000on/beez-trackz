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
            {/*
              Deliberately brand-neutral. `global-error` replaces the whole
              document when the root layout itself fails, which is exactly the
              case where the resolved brand did not reach the client — there is
              no BrandProvider above this and no server render to read. Naming
              the product here would mean either hardcoding a name a
              white-labelled deployment does not use, or leaking a second,
              unvalidated copy of the brand into the client bundle. Neither is
              worth it for the one screen that only appears when nothing else
              rendered.
            */}
            <p className="text-sm text-muted-foreground">
              The app could not load. Retry, or go back to the sign-in page.
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
