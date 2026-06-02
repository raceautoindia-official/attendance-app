import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // ---------------------------------------------------------------------------
  // Security headers
  // ---------------------------------------------------------------------------
  async headers() {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

    return [
      // Applied to every route
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // WebAuthn needs: publickey-credentials-get, publickey-credentials-create, geolocation for attendance
          {
            key: 'Permissions-Policy',
            value:
              'camera=(), microphone=(), geolocation=(self), ' +
              'publickey-credentials-get=(self), publickey-credentials-create=(self)',
          },
        ],
      },
      // Applied to API routes — restrict CORS to the app origin
      {
        source: '/api/(.*)',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: appUrl },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
        ],
      },
    ];
  },

  // ---------------------------------------------------------------------------
  // Misc hardening
  // ---------------------------------------------------------------------------
  poweredByHeader: false,       // removes X-Powered-By: Next.js
  compress: true,               // gzip/brotli at the Node layer (Nginx should do it in prod)

  // Turbopack is the default bundler in Next.js 16.
  // An empty config satisfies the "webpack config without turbopack config" guard.
  turbopack: {},
};

export default nextConfig;
