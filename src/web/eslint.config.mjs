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
