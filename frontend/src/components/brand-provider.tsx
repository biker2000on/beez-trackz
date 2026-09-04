"use client";

import * as React from "react";

import type { Brand } from "@/lib/brand";

/**
 * Client-side access to the resolved brand.
 *
 * The brand is resolved exactly once, on the server, by `resolveBrand()` in
 * `@/lib/brand`. The root layout serializes that same object into this
 * provider, so a client component and the server-rendered HTML around it can
 * never disagree about the name: there is one resolution, not two.
 *
 * This file deliberately imports only the `Brand` *type* from `@/lib/brand`.
 * The type is erased at compile time, so the server-only `process.env` reads
 * in that module are never pulled into the browser bundle.
 *
 * It lives in `components/` rather than as `lib/brand.tsx` on purpose: a
 * `lib/brand.ts` and a `lib/brand.tsx` both answer to the specifier
 * `@/lib/brand`, and TypeScript and Turbopack do not agree on which extension
 * wins. That collision would typecheck against the server module while the
 * bundler served the `"use client"` one — the exact class of bug this contract
 * exists to prevent. One specifier, one file.
 */
const BrandContext = React.createContext<Brand | null>(null);

export function BrandProvider({
  brand,
  children,
}: {
  brand: Brand;
  children: React.ReactNode;
}) {
  // `brand` is a plain, frozen-by-convention object that arrives identical on
  // every render, so memoising it keeps consumers from re-rendering on an
  // unrelated layout re-render.
  const value = React.useMemo(() => brand, [brand]);
  return (
    <BrandContext.Provider value={value}>{children}</BrandContext.Provider>
  );
}

/**
 * The resolved brand, for client components.
 *
 * Throws when used outside the root layout's provider. That is intentional:
 * a silent fallback here is exactly how one surface ends up saying "Apiary
 * Atlas" while the rest of the app says "GentleBee Atlas".
 */
export function useBrand(): Brand {
  const brand = React.useContext(BrandContext);
  if (brand === null) {
    throw new Error("useBrand must be used inside <BrandProvider>");
  }
  return brand;
}
