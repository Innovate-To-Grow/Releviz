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
    "app/**/*.{js,jsx}",
    "components/**/*.{js,jsx}",
    "lib/**/*.{js,jsx}",
    "!**/.next/**",
    "!**/node_modules/**",
  ],
  coverageReporters: ["text", "lcov", "json-summary", "cobertura"],
  coverageThreshold: {
    global: {
      statements: 86,
      branches: 74,
      functions: 84,
      lines: 88,
    },
    "./app/temp-access/TempAccessClient.js": {
      statements: 78,
      branches: 60,
      functions: 78,
      lines: 80,
    },
    "./components/auth/ContinueWithEmailPage.js": {
      statements: 95,
      branches: 85,
      functions: 100,
      lines: 100,
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
    "./components/schedule/ScheduleChannelEditor.js": {
      statements: 82,
      branches: 60,
      functions: 90,
      lines: 83,
    },
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
};

module.exports = createJestConfig(config);
