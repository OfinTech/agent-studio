import type { NextConfig } from "next";
const config: NextConfig = {
  // The development indicator overlaps the full-height canvas controls on mobile.
  devIndicators: false,
  serverExternalPackages: ["pg", "pg-boss"],
  experimental: { externalDir: true },
};
export default config;
