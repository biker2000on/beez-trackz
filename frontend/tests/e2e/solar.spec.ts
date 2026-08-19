import { expect, test } from "@playwright/test";

import { formatClock, solarPosition } from "../../src/features/canvas/lib/solar";

// Pure-function check (no browser). Reference: NOAA solar calculator,
// Asheville NC (35.595, -82.551), local time America/New_York.
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

test.describe("solar model", () => {
  test.skip(
    Intl.DateTimeFormat().resolvedOptions().timeZone !== "America/New_York",
    "sunrise expectations are expressed in America/New_York local time",
  );

  test("equinox and solstice sunrise/sunset within 3 minutes of NOAA", () => {
    const eq = solarPosition(35.595, -82.551, new Date("2026-03-20T12:00:00"));
    expect(Math.abs((eq.sunriseMinutes ?? 0) - minutesOf("07:34"))).toBeLessThanOrEqual(3);
    expect(Math.abs((eq.sunsetMinutes ?? 0) - minutesOf("19:42"))).toBeLessThanOrEqual(3);
    const sol = solarPosition(35.595, -82.551, new Date("2026-06-21T12:00:00"));
    expect(Math.abs((sol.sunriseMinutes ?? 0) - minutesOf("06:16"))).toBeLessThanOrEqual(3);
    expect(formatClock(sol.sunsetMinutes)).toBe("20:48");
  });
});
