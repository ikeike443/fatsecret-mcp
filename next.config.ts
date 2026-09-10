import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Both default to true in Next 16.3, set explicitly because this repo
    // depends on them: CI restores `.next/cache` (see the "Restore Next.js build
    // cache" step in .github/workflows/ci.yml) so `next build` starts warm, and
    // `npm run build:measure` grades warm builds against a tighter budget than
    // cold ones. If either default flips, that budget starts failing for a
    // reason unrelated to this codebase.
    turbopackFileSystemCacheForBuild: true,
    turbopackFileSystemCacheForDev: true,
  },
};

export default nextConfig;
