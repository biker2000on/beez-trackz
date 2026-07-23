import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Beez Trackz",
    short_name: "Beez Trackz",
    description:
      "Self-hosted beekeeping tracker — apiaries, hives, queens, and honey.",
    start_url: "/dashboard",
    display: "standalone",
    scope: "/",
    orientation: "portrait",
    theme_color: "#d97706",
    background_color: "#fbf7ef",
    categories: ["productivity", "utilities"],
    shortcuts: [
      {
        name: "Apiaries",
        short_name: "Apiaries",
        description: "Open your bee yards",
        url: "/apiaries",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Hives",
        short_name: "Hives",
        description: "Browse and record hive work",
        url: "/hives",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Honey harvest",
        short_name: "Harvest",
        description: "Open the honey ledger",
        url: "/harvest",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
    ],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
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
    ],
  };
}
