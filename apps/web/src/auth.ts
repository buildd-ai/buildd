import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';

const isDevelopment = process.env.NODE_ENV === 'development';

// Whitelist of allowed emails in production
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    // Dev mode auto-login
    ...(isDevelopment
      ? [
          Credentials({
            id: 'dev-auto-login',
            name: 'Dev Auto Login',
            credentials: {},
            async authorize() {
              return {
                id: 'dev-user',
                email: 'dev@localhost',
                name: 'Dev User',
              };
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    async signIn({ user }) {
      // Allow all in development
      if (isDevelopment) return true;

      // Production: check whitelist
      if (!user.email) return false;
      if (ALLOWED_EMAILS.length === 0) return true; // No whitelist = allow all
      return ALLOWED_EMAILS.includes(user.email.toLowerCase());
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
});
