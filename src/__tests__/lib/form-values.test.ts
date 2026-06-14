import { describe, expect, it } from "vitest";
import { formValues, normalizeFormData } from "@/lib/form-values";

describe("normalizeFormData", () => {
  it("strips React action-state numeric prefixes from field names", () => {
    const formData = new FormData();
    formData.set("0", '[null,"$K1"]');
    formData.set("1_name", "Lenoir");
    formData.set("1_latitude", "35.9");
    formData.set("1_longitude", "-81.5");
    formData.set("1_notes", "home yard");

    const normalized = normalizeFormData(formData);

    expect(normalized.get("name")).toBe("Lenoir");
    expect(normalized.get("latitude")).toBe("35.9");
    expect(normalized.get("longitude")).toBe("-81.5");
    expect(normalized.get("notes")).toBe("home yard");
    expect(normalized.has("0")).toBe(false);
    expect(normalized.has("1_name")).toBe(false);
  });

  it("leaves ordinary form data alone", () => {
    const formData = new FormData();
    formData.set("name", "Lenoir");

    expect(normalizeFormData(formData)).toBe(formData);
    expect(formValues(formData)).toEqual({ name: "Lenoir" });
  });
});
