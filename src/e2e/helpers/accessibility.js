const AxeBuilder = require("@axe-core/playwright").default;
const { expect } = require("@playwright/test");

// `exclude` lists selectors axe skips, for content that is not page UI and
// that axe cannot run inside (see the email preview in accessibility.spec.js).
async function expectAccessible(page, label, { exclude = [] } = {}) {
  let builder = new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
  ]);
  for (const selector of exclude) builder = builder.exclude(selector);
  const results = await builder.analyze();
  expect(
    results.violations,
    `${label} accessibility violations:\n${results.violations
      .map(
        (violation) =>
          `${violation.id} (${violation.impact}): ${violation.help}\n${violation.nodes
            .map((node) => `  ${node.target.join(" ")}: ${node.failureSummary}`)
            .join("\n")}`
      )
      .join("\n")}`
  ).toEqual([]);
}

// Fails when the page scrolls sideways or anything reaches past the viewport
// edge. Content inside a horizontally scrolling box (the calendar canvas, a
// responsive table) may extend past the edge; anything else that reaches past
// it widens the page instead.
async function expectNoHorizontalScroll(page, label) {
  const layout = await page.evaluate(() => {
    const insideScroller = (element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const overflowX = window.getComputedStyle(node).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") return true;
      }
      return false;
    };
    const limit = window.innerWidth + 1;
    const offenders = [];
    for (const element of document.querySelectorAll("body *")) {
      if (element.getBoundingClientRect().right <= limit) continue;
      if (insideScroller(element)) continue;
      const tag = element.tagName.toLowerCase();
      const className = (element.getAttribute("class") || "").trim();
      offenders.push(className ? `${tag}.${className.split(/\s+/).join(".")}` : tag);
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      offenders,
    };
  });
  expect(layout.scrollWidth, `${label} must not scroll horizontally`).toBeLessThanOrEqual(
    layout.clientWidth
  );
  expect(layout.offenders, `elements reaching past the viewport in ${label}`).toEqual([]);
}

module.exports = { expectAccessible, expectNoHorizontalScroll };
