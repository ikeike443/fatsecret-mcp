import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Enforced as an error, not a warning: `npm run lint` runs bare
      // `eslint`, which exits 0 on warnings, so a warning here would not
      // actually gate CI.
      //
      // 15 is the route-handler ceiling. /api/oauth/token's POST sits at 14
      // because each rejected branch reports a distinct security event (see
      // lib/securityAlert.ts) — flattening those branches to lower the
      // number would erase the audit trail the branches exist to produce.
      complexity: ["error", { max: 15 }],
    },
  },
  {
    // Everything outside app/ is pure logic with no per-branch audit
    // requirement, so it gets the tighter budget. The current maximum is
    // describeErrorChain in lib/fatsecret/appAuth.ts at 10.
    files: ["lib/**/*.ts", "scripts/**/*.ts"],
    rules: {
      complexity: ["error", { max: 10 }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
