import prettierConfig from "eslint-config-prettier";

const config = [
  prettierConfig,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["error"] }],
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
