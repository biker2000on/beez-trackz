export interface CanvasSurfaceMeasurement {
  clientWidth: number;
  getBoundingClientRect(): { top: number; width: number };
}

export function measureCanvasSurface(
  surface: CanvasSurfaceMeasurement,
  viewportHeight: number,
) {
  const rect = surface.getBoundingClientRect();
  return {
    // clientWidth excludes the surface border. Measuring the border-box and
    // then assigning that width to a child canvas makes the next border-box
    // two pixels wider, creating a ResizeObserver feedback loop.
    width: Math.max(320, Math.floor(surface.clientWidth)),
    height: Math.max(400, Math.floor(viewportHeight - rect.top - 40)),
  };
}
