import {
  lerpColor,
  lerpVirtualColor,
  color0,
  color1,
  color2,
  virtualColor0,
  virtualColor1,
  virtualColor2,
} from "../../components/ui/ColorUtils";

describe("color constants", () => {
  test("color0 is the busy/red color", () => {
    expect(color0).toBe("#f1aeb5");
  });

  test("color1 is the partial/yellow color", () => {
    expect(color1).toBe("#ffe69c");
  });

  test("color2 is the free/green color", () => {
    expect(color2).toBe("#a3cfbb");
  });
});

describe("lerpColor", () => {
  test("returns a valid rgb(...) string", () => {
    expect(lerpColor(0)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(lerpColor(0.5)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(lerpColor(1)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  // color0 = #f1aeb5 → rgb(241, 174, 181)
  test("amount=0 returns color0 (busy/red)", () => {
    expect(lerpColor(0)).toBe("rgb(241, 174, 181)");
  });

  // color2 = #a3cfbb → rgb(163, 207, 187)
  test("amount=1 returns color2 (free/green)", () => {
    expect(lerpColor(1)).toBe("rgb(163, 207, 187)");
  });

  // color1 = #ffe69c → rgb(255, 230, 156) — boundary between the two lerps
  test("amount=0.5 returns color1 (partial/yellow)", () => {
    expect(lerpColor(0.5)).toBe("rgb(255, 230, 156)");
  });

  test("amount=0.25 interpolates between color0 and color1", () => {
    const result = lerpColor(0.25);
    // Should be midpoint of red and yellow
    expect(result).toBe("rgb(248, 202, 168)");
  });

  test("amount=0.75 interpolates between color1 and color2", () => {
    const result = lerpColor(0.75);
    expect(result).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    // Should be midpoint of yellow and green — not red
    expect(result).not.toBe("rgb(241, 174, 181)");
  });
});

describe("virtual color constants", () => {
  test("use red, purple, and blue stops", () => {
    expect(virtualColor0).toBe("#f1aeb5");
    expect(virtualColor1).toBe("#c5b3e6");
    expect(virtualColor2).toBe("#9ec5fe");
  });
});

describe("lerpVirtualColor", () => {
  test.each([
    [0, "rgb(241, 174, 181)"],
    [0.5, "rgb(197, 179, 230)"],
    [1, "rgb(158, 197, 254)"],
  ])("maps %s to %s", (amount, expected) => {
    expect(lerpVirtualColor(amount)).toBe(expected);
  });

  test("uses a different free color from the in-person gradient", () => {
    expect(lerpVirtualColor(1)).not.toBe(lerpColor(1));
  });
});
