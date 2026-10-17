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
    // The React Native app is a separate Expo project with its own toolchain.
    "mobile/**",
  ]),
  {
    // The .js files under scripts/ and tests/ are plain Node programs, run
    // directly with `node` - no bundler, no module resolution, nothing to
    // transpile them. require() is correct there, and flagging it 102 times
    // only trained everybody to read `npm run lint` output as noise and stop
    // reading it at all.
    files: ["scripts/**/*.js", "tests/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
