# PWA Setup Documentation

## Overview

Beez Trackz includes Progressive Web App (PWA) support, allowing users to install the app on their devices and use it offline.

## Implementation

### 1. Web App Manifest

Location: `src/app/manifest.ts`

The manifest defines the app's metadata for installation:
- **Name**: Beez Trackz
- **Theme Color**: #f59e0b (amber-500, bee theme)
- **Start URL**: /dashboard
- **Display Mode**: standalone

### 2. Service Worker

Location: `src/sw.ts` → Compiled to `public/sw.js`

Built with [Serwist](https://serwist.js.org/), the service worker handles:
- **Precaching**: Static assets are cached during installation
- **Runtime Caching**: Uses Serwist's defaultCache strategy
  - App shell and static assets
  - API routes
  - Navigation/pages
  - Images and thumbnails

### 3. Install Prompt

Location: `src/components/pwa/install-prompt.tsx`

A client-side component that:
- Listens for the `beforeinstallprompt` event
- Shows a dismissible banner prompting users to install
- Stores dismissal preference in localStorage
- Styled with amber theme to match beekeeping branding

### 4. Next.js Configuration

The `next.config.ts` file includes the Serwist plugin:

```typescript
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "src/sw.ts",
  swDest: "public/sw.js",
});

export default withSerwist(nextConfig);
```

## Usage

### Adding the Install Prompt

To use the install prompt in your app, import it in your layout or a specific page:

```tsx
import { InstallPrompt } from "@/components/pwa/install-prompt";

export default function Layout({ children }) {
  return (
    <>
      {children}
      <InstallPrompt />
    </>
  );
}
```

### Testing PWA Locally

1. Build the production version:
   ```bash
   npm run build
   npm start
   ```

2. Open Chrome DevTools → Application → Manifest
3. Verify manifest loads correctly
4. Check Service Workers tab to see if sw.js is registered
5. Use Lighthouse to audit PWA compliance

### Testing Installation

1. In Chrome, visit the app over HTTPS (or localhost)
2. Look for the install banner (or dismiss and re-trigger via browser menu)
3. Click "Install" to add to home screen/apps
4. Verify the app opens in standalone mode

## Icons

**Status**: Placeholder icons needed

See `public/ICONS-TODO.md` for requirements:
- `icon-192.png` (192x192)
- `icon-512.png` (512x512)

Recommended to use bee/honeycomb imagery with amber theme colors.

## Offline Support

The service worker uses Serwist's default caching strategies, which include:
- **CacheFirst** for static assets (long-lived)
- **NetworkFirst** for navigation (fallback to cache)
- **StaleWhileRevalidate** for API routes

To test offline:
1. Open DevTools → Application → Service Workers
2. Check "Offline" checkbox
3. Navigate the app - cached pages should still work

## Troubleshooting

### Service Worker Not Updating

If you make changes to `src/sw.ts` and they don't reflect:

1. Clear service worker cache in DevTools
2. Rebuild: `npm run build`
3. Hard refresh (Ctrl+Shift+R / Cmd+Shift+R)
4. Check "Update on reload" in DevTools → Application → Service Workers

### Manual Registration (Fallback)

If Serwist integration fails with future Next.js versions, you can register the service worker manually:

```tsx
// src/components/pwa/register-sw.tsx
"use client";

import { useEffect } from "react";

export function RegisterServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          console.log("SW registered:", registration);
        })
        .catch((error) => {
          console.error("SW registration failed:", error);
        });
    }
  }, []);

  return null;
}
```

Then create a plain service worker in `public/sw.js` without the Serwist plugin.

## Compatibility

- **Next.js**: 15.x (tested with 15.1.6)
- **Serwist**: Compatible with Next.js 15
- **Browsers**: All modern browsers with service worker support

## Resources

- [Serwist Documentation](https://serwist.js.org/)
- [Next.js PWA Guide](https://nextjs.org/docs/app/building-your-application/configuring/progressive-web-apps)
- [MDN Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [Web App Manifest](https://developer.mozilla.org/en-US/docs/Web/Manifest)
