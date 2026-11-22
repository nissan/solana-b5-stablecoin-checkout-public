import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Stop `next dev` writing its own AGENTS.md into the project.
  agentRules: false,
  serverExternalPackages: ["ws"],
  turbopack: {
    resolveAlias: {
      fs: { browser: "./empty-module.js" },
    },
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    }
    return config;
  },
};

export default nextConfig;
