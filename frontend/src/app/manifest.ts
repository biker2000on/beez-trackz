import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Beez Trackz",
    short_name: "Beez Trackz",
    description:
      "Self-hosted beekeeping tracker — apiaries, hives, queens, and honey.",
    start_url: "/dashboard",
    display: "standalone",
    orientation: "portrait",
    theme_color: "#d97706",
    background_color: "#fbf7ef",
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
