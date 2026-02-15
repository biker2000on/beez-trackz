import { describe, it, expect } from "vitest";
import { getQueenColor, getQueenColorForDate } from "@/lib/queen-colors";

describe("queen colors", () => {
  it("year ending in 1 or 6 should be white", () => {
    expect(getQueenColor(2021)).toBe("white");
    expect(getQueenColor(2026)).toBe("white");
  });

  it("year ending in 2 or 7 should be yellow", () => {
    expect(getQueenColor(2022)).toBe("yellow");
    expect(getQueenColor(2027)).toBe("yellow");
  });

  it("year ending in 3 or 8 should be red", () => {
    expect(getQueenColor(2023)).toBe("red");
    expect(getQueenColor(2028)).toBe("red");
  });

  it("year ending in 4 or 9 should be green", () => {
    expect(getQueenColor(2024)).toBe("green");
    expect(getQueenColor(2029)).toBe("green");
  });

  it("year ending in 5 or 0 should be blue", () => {
    expect(getQueenColor(2025)).toBe("blue");
    expect(getQueenColor(2020)).toBe("blue");
  });

  it("should return null for null date", () => {
    expect(getQueenColorForDate(null)).toBeNull();
  });

  it("should return correct color for a date", () => {
    expect(getQueenColorForDate(new Date("2023-06-15"))).toBe("red");
  });
});
