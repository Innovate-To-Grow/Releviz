import nextConfig from "eslint-config-next";
import prettierConfig from "eslint-config-prettier";

const config = [
  ...nextConfig,
  prettierConfig,
  {
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["error"] }],
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["**/__tests__/**/*.js"],
    rules: {
      "no-unused-vars": "off",
      "no-console": "off",
    },
  },
];

export default config;
