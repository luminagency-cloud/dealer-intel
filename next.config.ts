import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Evidence uploads (screenshots, HTML snapshots) exceed the 1mb default.
      bodySizeLimit: "20mb",
    },
  },
};

export default nextConfig;
