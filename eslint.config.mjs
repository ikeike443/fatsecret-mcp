import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Deliberately unscoped, so nothing escapes a complexity budget: this
    // covers app/, test/ and the root config files. lib/ and scripts/ get the
    // tighter budget from the next block.
    rules: {
      // Enforced as an error, not a warning: `npm run lint` runs bare
      // `eslint`, which exits 0 on warnings, so a warning here would not
      // actually gate CI.
      //
      // Both ceilings are "current measured maximum + 2", so a routine edit
      // doesn't trip the gate but unbounded growth still does. Measured with
      // `npx eslint --rule '{"complexity":["error",{"max":1}]}'`; re-measure
      // and re-tighten when the maxima move.
      //
      // 12 is /api/oauth/authorize's GET, and it genuinely needs the looser
      // budget: each of its rejected branches reports a *distinct* security
      // event (see lib/securityAlert.ts), so flattening them would erase the
      // audit trail the branches exist to produce.
      complexity: ["error", { max: 14 }],
    },
  },
  {
    // lib/ and scripts/ are pure logic with no per-branch audit requirement,
    // so they get the tighter budget. Current maximum is describeErrorChain in
    // lib/fatsecret/appAuth.ts at 10.
    files: ["lib/**/*.ts", "scripts/**/*.ts"],
    rules: {
      complexity: ["error", { max: 12 }],
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
