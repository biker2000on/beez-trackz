// Code generated from backend/internal/httpapi/offline_routes.go.
// DO NOT EDIT — regenerate with:
//   cd backend && go test ./internal/httpapi \
//     -run TestOfflineRouteManifestMatchesFrontend -update-offline-routes
//
// The service worker (src/app/sw.js/route.ts) and the API's offline receipt
// middleware must queue exactly the same routes; generating this file is what
// keeps the two halves from drifting.

export interface OfflineRouteRule {
  prefix: string;
  exact?: boolean;
  methods?: string[];
  exceptMethods?: string[];
}

export interface OfflineRouteManifest {
  rules: OfflineRouteRule[];
  postExclusions: string[];
}

export const OFFLINE_ROUTE_MANIFEST: OfflineRouteManifest = {
  "rules": [
    {
      "prefix": "/api/v1/inspections"
    },
    {
      "prefix": "/api/v1/feedings"
    },
    {
      "prefix": "/api/v1/bloom-observations"
    },
    {
      "prefix": "/api/v1/mite-counts"
    },
    {
      "prefix": "/api/v1/treatment-events"
    },
    {
      "prefix": "/api/v1/queen-events"
    },
    {
      "prefix": "/api/v1/queens"
    },
    {
      "prefix": "/api/v1/photos/"
    },
    {
      "prefix": "/api/v1/canvas/"
    },
    {
      "prefix": "/api/v1/harvest-sessions/"
    },
    {
      "prefix": "/api/v1/harvest-entries/"
    },
    {
      "prefix": "/api/v1/recommendations/"
    },
    {
      "prefix": "/api/v1/harvests"
    },
    {
      "prefix": "/api/v1/honey/jarring"
    },
    {
      "prefix": "/api/v1/honey/bulk-movements"
    },
    {
      "prefix": "/api/v1/honey/give-away"
    },
    {
      "prefix": "/api/v1/honey/jar-adjustments"
    },
    {
      "prefix": "/api/v1/honey/movements/"
    },
    {
      "prefix": "/api/v1/honey/sales"
    },
    {
      "prefix": "/api/v1/sales"
    },
    {
      "prefix": "/api/v1/jar-sizes"
    },
    {
      "prefix": "/api/v1/expenses"
    },
    {
      "prefix": "/api/v1/customers"
    },
    {
      "prefix": "/api/v1/harvest-lots"
    },
    {
      "prefix": "/api/v1/wholesale-price-lists"
    },
    {
      "prefix": "/api/v1/products"
    },
    {
      "prefix": "/api/v1/propolis-harvests"
    },
    {
      "prefix": "/api/v1/product-batches"
    },
    {
      "prefix": "/api/v1/hives/bulk",
      "exact": true
    },
    {
      "prefix": "/api/v1/hives/",
      "exceptMethods": [
        "DELETE"
      ]
    },
    {
      "prefix": "/api/v1/apiaries/",
      "methods": [
        "PUT"
      ]
    },
    {
      "prefix": "/api/v1/splits/",
      "methods": [
        "DELETE"
      ]
    }
  ],
  "postExclusions": [
    "/api/v1/canvas/hives",
    "/api/v1/harvest-sessions",
    "/api/v1/recommendations/run"
  ]
};
