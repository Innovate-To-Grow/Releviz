const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

const config = {
  testEnvironment: "node",
  testTimeout: 15000,
  testMatch: ["**/__tests__/**/*.test.js"],
  modulePathIgnorePatterns: ["<rootDir>/.next/"],
  testPathIgnorePatterns: ["<rootDir>/.next/"],
  collectCoverage: false,
  collectCoverageFrom: [
    "app/login/page.js",
    "app/feedback/page.js",
    "app/privacy/page.js",
    "app/recover/page.js",
    "app/settings/page.js",
    "app/signup/page.js",
    "app/support/page.js",
    "app/terms/page.js",
    "components/HomePage.js",
    "components/auth/AuthContext.js",
    "components/dashboard/DashboardPage.js",
    "components/event/CreateEvent.js",
    "components/event/EventDetailsGrid.js",
    "components/event/EventPage.js",
    "components/schedule/OrganizerScalePanels.js",
    "components/schedule/OrganizerScaleView.js",
    "components/schedule/ParticipantView.js",
    "components/schedule/RosterImportWizard.js",
    "components/schedule/RosterPanel.js",
    "components/schedule/ScheduleGrid.js",
    "components/ui/*.js",
    "lib/**/*.{js,jsx}",
    "!**/.next/**",
    "!**/node_modules/**",
  ],
  coverageReporters: ["text", "lcov", "json-summary", "cobertura"],
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 75,
      functions: 82,
      lines: 90,
    },
    "./components/dashboard/DashboardPage.js": {
      statements: 90,
      branches: 70,
      functions: 95,
      lines: 92,
    },
    "./components/event/CreateEvent.js": {
      statements: 78,
      branches: 65,
      functions: 40,
      lines: 82,
    },
    "./components/event/EventPage.js": {
      statements: 98,
      branches: 80,
      functions: 100,
      lines: 100,
    },
    "./components/schedule/OrganizerScaleView.js": {
      statements: 85,
      branches: 80,
      functions: 70,
      lines: 90,
    },
    "./components/schedule/ParticipantView.js": {
      statements: 84,
      branches: 67,
      functions: 80,
      lines: 86,
    },
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
};

module.exports = createJestConfig(config);
