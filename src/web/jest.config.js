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
    // Files with their own gate below are excluded from the global figure.
    global: {
      statements: 94,
      branches: 85,
      functions: 93,
      lines: 96,
    },
    "./app/temp-access/TempAccessClient.js": {
      statements: 90,
      branches: 76,
      functions: 95,
      lines: 92,
    },
    "./components/auth/ContinueWithEmailPage.js": {
      statements: 95,
      branches: 85,
      functions: 100,
      lines: 100,
    },
    "./components/dashboard/DashboardPage.js": {
      statements: 94,
      branches: 75,
      functions: 95,
      lines: 96,
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
    "./components/schedule/MeetingCalendar.js": {
      statements: 95,
      branches: 86,
      functions: 95,
      lines: 97,
    },
    "./components/schedule/OrganizerScalePanels.js": {
      statements: 96,
      branches: 85,
      functions: 98,
      lines: 98,
    },
    "./components/schedule/OrganizerScaleView.js": {
      statements: 96,
      branches: 86,
      functions: 98,
      lines: 98,
    },
    "./components/schedule/ParticipantView.js": {
      statements: 88,
      branches: 78,
      functions: 88,
      lines: 92,
    },
    "./components/schedule/RosterGroups.js": {
      statements: 100,
      branches: 95,
      functions: 100,
      lines: 100,
    },
    "./components/schedule/RosterImportWizard.js": {
      statements: 94,
      branches: 75,
      functions: 94,
      lines: 94,
    },
    "./components/schedule/RosterPanel.js": {
      statements: 94,
      branches: 81,
      functions: 92,
      lines: 95,
    },
    "./components/schedule/ScheduleChannelEditor.js": {
      statements: 95,
      branches: 85,
      functions: 95,
      lines: 95,
    },
    "./components/ui/Modal.js": {
      statements: 95,
      branches: 90,
      functions: 100,
      lines: 95,
    },
    "./lib/meetingWindows.js": {
      statements: 97,
      branches: 93,
      functions: 100,
      lines: 97,
    },
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
};

module.exports = createJestConfig(config);
