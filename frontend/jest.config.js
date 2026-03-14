const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

const config = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
};

module.exports = createJestConfig(config);
