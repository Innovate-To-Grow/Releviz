const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

const config = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js"],
  modulePathIgnorePatterns: ["<rootDir>/.next/"],
  testPathIgnorePatterns: ["<rootDir>/.next/"],
  collectCoverage: false,
  collectCoverageFrom: [
    "app/login/page.js",
    "app/settings/page.js",
    "app/signup/page.js",
    "components/HomePage.js",
    "components/auth/AuthContext.js",
    "components/event/EventDetailsGrid.js",
    "components/schedule/ScheduleGrid.js",
    "components/ui/*.js",
    "lib/**/*.{js,jsx}",
    "!**/.next/**",
    "!**/node_modules/**",
  ],
  coverageReporters: ["text", "lcov", "json-summary", "cobertura"],
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
};

module.exports = createJestConfig(config);
