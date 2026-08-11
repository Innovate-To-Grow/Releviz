import nextConfig from "eslint-config-next";
import prettierConfig from "eslint-config-prettier";

const config = [
  {
    ignores: [".next/**", "out/**", "coverage/**", "node_modules/**"],
  },
  ...nextConfig,
  prettierConfig,
  {
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["error"] }],
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
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
