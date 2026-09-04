import type { MetadataRoute } from "next";

import { resolveBrand } from "@/lib/brand";

/**
 * The manifest is generated per request for the same reason the root layout is
 * (see the note there): its name, colors, and icons come from runtime
 * BRAND_* configuration, and a prerendered manifest would freeze the build's
 * empty environment into every deployment.
 */
export const dynamic = "force-dynamic";

export default function manifest(): MetadataRoute.Manifest {
  const brand = resolveBrand();

  // A configured mark replaces the bundled icon set. It is one entry with no
  // declared size because the deployment supplies one file, not a generated
  // set; browsers scale it. `purpose: "any"` keeps it out of maskable slots,
  // where an un-padded custom mark would be cropped. With no BRAND_MARK_URL
  // the bundled Apiary Atlas icons — including the maskable pair — are used
  // unchanged.
  const brandIcons: MetadataRoute.Manifest["icons"] = brand.markUrl
    ? [{ src: brand.markUrl, purpose: "any" }]
    : [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        {
          src: "/icons/icon-maskable-192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "maskable",
        },
        {
          src: "/icons/icon-maskable-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ];

  const shortcutIcon = brand.markUrl
    ? [{ src: brand.markUrl }]
    : [{ src: "/icons/icon-192.png", sizes: "192x192" }];

  return {
    name: brand.displayName,
    short_name: brand.shortName,
    description: brand.tagline,
    // Machine identity: start_url, scope, display, and the shortcut URLs are
    // route contracts, not branding. They never move with the brand.
    start_url: "/today",
    display: "standalone",
    scope: "/",
    orientation: "portrait",
    theme_color: brand.themeColor,
    background_color: brand.backgroundColor,
    categories: ["productivity", "utilities"],
    shortcuts: [
      {
        name: "Apiaries",
        short_name: "Apiaries",
        description: "Open your bee yards",
        url: "/yard/apiaries",
        icons: shortcutIcon,
      },
      {
        name: "Hives",
        short_name: "Hives",
        description: "Browse and record hive work",
        url: "/yard/hives",
        icons: shortcutIcon,
      },
      {
        name: "Production",
        short_name: "Production",
        description: "Open the production ledger",
        url: "/production",
        icons: shortcutIcon,
      },
    ],
    icons: brandIcons,
  };
}
