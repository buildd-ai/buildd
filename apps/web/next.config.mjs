/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@buildd/shared', '@buildd/core'],
  async redirects() {
    return [
      {
        source: '/',
        destination: '/app',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
