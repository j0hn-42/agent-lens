/** @type {import('next').NextConfig} */
const nextConfig = {
  // The e2e demo server builds elsewhere so it can run next to a developer's own `next dev`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  images: {
    unoptimized: true,
  },
}

export default nextConfig
