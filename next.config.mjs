/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { serverActions: { bodySizeLimit: '50mb' } },
  webpack: (config) => {
    config.externals = config.externals || [];
    return config;
  },
};
export default nextConfig;