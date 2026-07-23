import { describe, expect, it } from "vitest";

import { measureCanvasSurface } from "../../../frontend/src/features/canvas/lib/sizing";

describe("measureCanvasSurface", () => {
  it("uses the content width so a bordered surface cannot grow on every resize", () => {
    const surface = {
      clientWidth: 1000,
      getBoundingClientRect: () => ({ top: 180, width: 1002 }),
    };

    expect(measureCanvasSurface(surface, 800)).toEqual({
      width: 1000,
      height: 580,
    });
  });
});
