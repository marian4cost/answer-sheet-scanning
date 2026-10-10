import type { NextConfig } from 'next';
import { resolve } from 'node:path';
import { config as dotenv } from 'dotenv';
dotenv({path: resolve(process.cwd(), '../../.env'), quiet: true});
const api = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.API_PORT || 3001}`;
const config: NextConfig = {
  experimental: {proxyClientMaxBodySize: '1gb', proxyTimeout: 300_000},
  async rewrites() {
    return [
      {source: '/api/:path*', destination: `${api}/api/:path*`},
      {source: '/media/:path*', destination: `${api}/media/:path*`},
    ];
  },
};
export default config;
