/** @type {import('next').NextConfig} */

// Address of the FastAPI backend. The browser never calls it directly for HTTP requests:
// it calls /api/... on this Next.js server, which forwards to the backend. This avoids CORS,
// because the existing backend does not configure any CORS middleware.
const BACKEND_URL = (process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8001').replace(
  /\/+$/,
  '',
)

const nextConfig = {
  allowedDevOrigins: ['10.189.120.170'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    // Face verification and large audio responses can take longer than the default proxy timeout.
    proxyTimeout: 120_000,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${BACKEND_URL}/:path*`,
      },
    ]
  },
}

export default nextConfig