import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep these out of the server bundle. Mastra and the libSQL driver resolve
  // native addons and load files at runtime, which bundling breaks; Next must
  // require them from node_modules instead.
  // The browser packages join them for the same reason plus one more: the
  // agent-browser stack loads Playwright's driver from disk and ships native
  // browser binaries, neither of which survives being traced into a bundle.
  serverExternalPackages: [
    '@mastra/core',
    '@mastra/libsql',
    '@libsql/client',
    'libsql',
    'firecrawl',
    '@mastra/browser-firecrawl',
    '@mastra/agent-browser',
    'agent-browser',
    'playwright-core',
  ],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'www.google.com',
        pathname: '/s2/favicons**',
      },
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
