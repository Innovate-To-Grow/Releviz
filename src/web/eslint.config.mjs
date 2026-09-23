import { fixupConfigRules } from "@eslint/compat";
import nextConfig from "eslint-config-next";
import prettierConfig from "eslint-config-prettier";
import * as espree from "espree";

const config = [
  {
    ignores: [".next/**", "out/**", "coverage/**", "node_modules/**"],
  },
  ...fixupConfigRules(nextConfig),
  prettierConfig,
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    languageOptions: {
      // Next's bundled Babel parser uses the pre-ESLint 10 scope API.
      // Standard JavaScript and JSX can use ESLint's supported parser directly.
      parser: espree,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["error", { allow: ["error"] }],
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/purity": "error",
      "react-hooks/refs": "error",
      "react-hooks/set-state-in-effect": "error",
    },
  },
  {
    files: ["**/__tests__/**/*.js"],
    rules: {
      "no-unused-vars": "off",
      "no-console": "off",
      "@next/next/no-img-element": "off",
    },
  },
];

export default config;
