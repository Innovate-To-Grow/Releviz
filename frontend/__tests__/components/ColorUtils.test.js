import { lerpColor, color0, color1, color2 } from "@/components/ui/ColorUtils";

describe("color constants", () => {
  test("color0 is the busy/red color", () => {
    expect(color0).toBe("#ffb4ab");
  });

  test("color1 is the partial/yellow color", () => {
    expect(color1).toBe("#ffdea3");
  });

  test("color2 is the free/green color", () => {
    expect(color2).toBe("#82d3a2");
  });
});

describe("lerpColor", () => {
  test("returns a valid rgb(...) string", () => {
    expect(lerpColor(0)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(lerpColor(0.5)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(lerpColor(1)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  // color0 = #ffb4ab → rgb(255, 180, 171)
  test("amount=0 returns color0 (busy/red)", () => {
    expect(lerpColor(0)).toBe("rgb(255, 180, 171)");
  });

  // color2 = #82d3a2 → rgb(130, 211, 162)
  test("amount=1 returns color2 (free/green)", () => {
    expect(lerpColor(1)).toBe("rgb(130, 211, 162)");
  });

  // color1 = #ffdea3 → rgb(255, 222, 163) — boundary between the two lerps
  test("amount=0.5 returns color1 (partial/yellow)", () => {
    expect(lerpColor(0.5)).toBe("rgb(255, 222, 163)");
  });

  test("amount=0.25 interpolates between color0 and color1", () => {
    const result = lerpColor(0.25);
    // Should be midpoint of red and yellow
    expect(result).toBe("rgb(255, 201, 167)");
  });

  test("amount=0.75 interpolates between color1 and color2", () => {
    const result = lerpColor(0.75);
    expect(result).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    // Should be midpoint of yellow and green — not red
    expect(result).not.toBe("rgb(255, 180, 171)");
  });
});
