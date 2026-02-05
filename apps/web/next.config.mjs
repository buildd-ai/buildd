/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@buildd/shared', '@buildd/core'],
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  async redirects() {
    return [
      {
        source: '/install.sh',
        destination: 'https://raw.githubusercontent.com/buildd-ai/buildd/main/apps/local-ui/install.sh',
        permanent: false,
      },
      {
        source: '/install.ps1',
        destination: 'https://raw.githubusercontent.com/buildd-ai/buildd/main/apps/local-ui/install.ps1',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
