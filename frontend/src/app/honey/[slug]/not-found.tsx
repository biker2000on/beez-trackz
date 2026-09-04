import Link from "next/link";

import { resolveBrand } from "@/lib/brand";

export default function HoneyStoryNotFound() {
  const brand = resolveBrand();

  return (
    <main className="min-h-screen bg-[#fffaf0] text-stone-900">
      <div className="mx-auto max-w-3xl px-5 py-10 text-center sm:px-8 sm:py-16">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-amber-700">
          From hive to jar
        </p>
        <h1 className="font-serif text-4xl font-bold tracking-tight sm:text-5xl">
          We couldn&apos;t find this honey story
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-8 text-stone-600">
          This lot may no longer be public, or the link on the jar may be
          incomplete.
        </p>
        <Link
          className="mt-8 inline-flex rounded-md border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-50"
          href="/"
        >
          Back to {brand.displayName}
        </Link>
      </div>
    </main>
  );
}
