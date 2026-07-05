import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Evidence uploads (screenshots, HTML snapshots) exceed the 1mb default.
      bodySizeLimit: "20mb",
    },
  },
  logging: {
    incomingRequests: {
      // Polled every 3s by run-live-data.tsx while a run is active — floods
      // the terminal without telling you anything a failed request wouldn't.
      ignore: [/\/api\/runs\/.*\/status/],
    },
  },
};

export default nextConfig;
