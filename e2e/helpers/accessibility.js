const AxeBuilder = require("@axe-core/playwright").default;
const { expect } = require("@playwright/test");

async function expectAccessible(page, label) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
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
