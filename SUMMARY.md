# PR 5 — Yard map, elevation, and sun

Branch: `feat/1f80f067-pr-5-yard-map-sun`  
Migration: `00018_yard_map_elevation.sql` only.

## What shipped

### Leaflet as the map substrate
- Added `leaflet` + `@types/leaflet` in `frontend/` (no Google/Mapbox, no react-leaflet).
- Deleted the zoom-19 Konva mosaic (`satellite-layer.tsx`, `tiles.ts`). One tile engine.

### Location picker
- Shared Leaflet pin picker on the apiary form and a yard **Set location** action.
- Click or drag the pin; typed lat/lng write the pin.
- Device geolocation seeds lat/lng and `coords.altitude` when the browser supplies it.
- No location ⇒ no map under the canvas and no sun. Coordinates are never invented.

### Elevation (`apiaries.elevation_m`)
- Nullable meters + `elevation_source` (`geolocation` | `terrain` | `override`).
- Filled from device altitude (labeled), Open-Meteo terrain lookup, or operator override.
- Sea-level `0` is kept only when supplied. Null stays null.
- Shown on apiary list and detail with the source label.

### Tile layers
- Esri World Imagery (default, stand registration).
- Esri World Street Map (streets/labels when zoomed out).
- Imagery opacity slider.
- README privacy note names who sees coords (Esri tiles; Open-Meteo on terrain lookup).

### Georeferenced canvas
- Leaflet owns pan/zoom, including zoom well below 19.
- Konva overlay is transformed so stands stay nailed to lat/lng.
- **Register** mode locks the map; the operator nudges the stand layer (offset / rotation / scale) persisted in `canvas_layout.registration`.
- Occupied slots derive lat/lng from the registered canvas (shown on hive/slot menus). No second layout table.

### Sun overlay
- Date + time-of-day scrubber.
- NOAA Solar Calculator math (local, from lat/lng/date): azimuth, solar altitude, sunrise/sunset bearings.
- Simple hive-body shadows. Ground elevation is a separate column — not overloaded.

## Files of note
- `backend/internal/db/migrations/00018_yard_map_elevation.sql`
- `backend/internal/httpapi/routes_apiaries.go` (+ unit test for elevation normalize)
- `backend/internal/httpapi/routes_canvas.go` (persist `registration` + `mapView`)
- `frontend/src/features/map/*`
- `frontend/src/features/canvas/stage/yard-map.tsx`, `sun-layer.tsx`
- `frontend/src/features/canvas/lib/geo.ts`, `solar.ts`
