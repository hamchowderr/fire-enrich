import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep these out of the server bundle. Mastra and the libSQL driver resolve
  // native addons and load files at runtime, which bundling breaks; Next must
  // require them from node_modules instead.
  serverExternalPackages: [
    '@mastra/core',
    '@mastra/libsql',
    '@libsql/client',
    'libsql',
    'firecrawl',
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
