"use client";

import { useEffect } from "react";
import Link from "next/link";

import { useBrand } from "@/components/brand-provider";

export default function HoneyStoryError({
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

  const brand = useBrand();
  const retry = unstable_retry ?? reset;

  return (
    <main className="min-h-screen bg-[#fffaf0] text-stone-900">
      <div className="mx-auto max-w-3xl px-5 py-10 text-center sm:px-8 sm:py-16">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-amber-700">
          From hive to jar
        </p>
        <h1 className="font-serif text-4xl font-bold tracking-tight sm:text-5xl">
          This story is temporarily unavailable
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-8 text-stone-600">
          We couldn&apos;t load this honey&apos;s story. Please try again in a
          moment.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {retry ? (
            <button
              type="button"
              className="rounded-md border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-50"
              onClick={() => retry()}
            >
              Try again
            </button>
          ) : null}
          <Link
            className="rounded-md px-4 py-2 text-sm font-semibold text-stone-500 transition hover:text-stone-800"
            href="/"
          >
            Back to {brand.displayName}
          </Link>
        </div>
      </div>
    </main>
  );
}
