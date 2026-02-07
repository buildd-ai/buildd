import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import GitHub from 'next-auth/providers/github';
import Credentials from 'next-auth/providers/credentials';
import { db } from '@buildd/core/db';
import { users, accounts, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';

const isDevelopment = process.env.NODE_ENV === 'development';

// Cookie domain for cross-subdomain auth (e.g., .buildd.dev)
// This allows cookies to be shared between app.buildd.dev and buildd.dev
const cookieDomain = process.env.AUTH_COOKIE_DOMAIN;

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  cookies: cookieDomain
    ? {
        pkceCodeVerifier: {
          name: 'authjs.pkce.code_verifier',
          options: {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            secure: true,
            domain: cookieDomain,
          },
        },
        state: {
          name: 'authjs.state',
          options: {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            secure: true,
            domain: cookieDomain,
          },
        },
        callbackUrl: {
          name: 'authjs.callback-url',
          options: {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            secure: true,
            domain: cookieDomain,
          },
        },
        sessionToken: {
          name: 'authjs.session-token',
          options: {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            secure: true,
            domain: cookieDomain,
          },
        },
      }
    : undefined,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          prompt: 'select_account',
        },
      },
    }),
    GitHub({
      clientId: process.env.GITHUB_APP_CLIENT_ID!,
      clientSecret: process.env.GITHUB_APP_CLIENT_SECRET!,
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
    async signIn({ user, account }) {
      // Allow all in development
      if (isDevelopment) return true;

      const provider = account?.provider;
      if (provider !== 'google' && provider !== 'github') return true;

      const providerId = account!.providerAccountId;
      if (!providerId || !user.email) return false;

      try {
        // Look up by provider ID
        const existingUser = provider === 'google'
          ? await db.query.users.findFirst({ where: eq(users.googleId, providerId) })
          : await db.query.users.findFirst({ where: eq(users.githubId, providerId) });

        if (existingUser) return true;

        // No user with this provider ID — check by email for linking
        const emailUser = await db.query.users.findFirst({
          where: eq(users.email, user.email),
        });

        if (emailUser) {
          // Link this provider to the existing user
          const updateField = provider === 'google'
            ? { googleId: providerId }
            : { githubId: providerId };
          await db.update(users).set(updateField).where(eq(users.id, emailUser.id));
          console.log(`Linked ${provider} to existing user: ${user.email}`);
          return true;
        }

        // Brand new user — create user + account + workspace
        const [newUser] = await db
          .insert(users)
          .values({
            ...(provider === 'google' ? { googleId: providerId } : { githubId: providerId }),
            email: user.email,
            name: user.name || null,
            image: user.image || null,
          })
          .returning();

        await db.insert(accounts).values({
          name: `${user.name || user.email}'s Account`,
          type: 'user',
          authType: 'oauth',
          apiKey: generateApiKey(),
          maxConcurrentWorkers: 3,
          ownerId: newUser.id,
        });

        await db.insert(workspaces).values({
          name: 'My Workspace',
          ownerId: newUser.id,
        });

        console.log(`Created new user: ${user.email} via ${provider}`);
        return true;
      } catch (error) {
        console.error('Error during sign-in user creation:', error);
        return false;
      }
    },
    async jwt({ token, account }) {
      // On initial sign-in, look up the DB user and store their ID
      if (account?.provider === 'google' || account?.provider === 'github') {
        try {
          const dbUser = account.provider === 'google'
            ? await db.query.users.findFirst({ where: eq(users.googleId, account.providerAccountId) })
            : await db.query.users.findFirst({ where: eq(users.githubId, account.providerAccountId) });
          if (dbUser) {
            token.userId = dbUser.id;
          }
        } catch (error) {
          console.error('Error looking up user in JWT callback:', error);
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        // Use the DB user ID if available, otherwise fall back to token.sub
        session.user.id = token.userId || token.sub || '';
      }
      return session;
    },
  },
  pages: {
    signIn: '/app/auth/signin',
    error: '/app/auth/error',
  },
});
