/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@buildd/shared', '@buildd/core'],
  async redirects() {
    return [
      {
        source: '/',
        destination: '/app/home',
        permanent: false,
      },
      {
        source: '/app',
        destination: '/app/home',
        permanent: false,
      },
      {
        source: '/app/dashboard',
        destination: '/app/home',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
