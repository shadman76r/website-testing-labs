import type { NextConfig } from "next";
const chromiumAssets = ["./node_modules/@sparticuz/chromium/bin/**/*"];
const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["playwright", "@sparticuz/chromium", "axe-core", "lighthouse", "chrome-launcher", "pg"],
  outputFileTracingIncludes: {
    "/api/run": chromiumAssets,
    "/api/discover": chromiumAssets,
    "/api/test-cases": chromiumAssets,
  }
};
export default nextConfig;
