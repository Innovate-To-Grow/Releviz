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

module.exports = { expectAccessible };
