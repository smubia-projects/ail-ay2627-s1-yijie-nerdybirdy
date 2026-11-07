import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // pdf.js worker copied from node_modules (vendor code).
    "public/pdf.worker.min.mjs",
    // API bundle (npm run build:server) and the vendored shared rate-limit engine.
    "server/dist/**",
    "server/rateLimitEngine.js",
  ]),
]);

export default eslintConfig;
