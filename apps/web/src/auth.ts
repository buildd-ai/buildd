import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { db } from '@buildd/core/db';
import { users, accounts, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';

const isDevelopment = process.env.NODE_ENV === 'development';

function generateApiKey(): string {
  return `bld_${randomBytes(32).toString('hex')}`;
}

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
    async signIn({ user, account }) {
      // Allow all in development
      if (isDevelopment) return true;

      // Only handle Google sign-ins for user creation
      if (account?.provider !== 'google') return true;

      const googleId = account.providerAccountId;
      if (!googleId || !user.email) return false;

      try {
        // Check if user already exists
        const existingUser = await db.query.users.findFirst({
          where: eq(users.googleId, googleId),
        });

        if (!existingUser) {
          // Create new user
          const [newUser] = await db
            .insert(users)
            .values({
              googleId,
              email: user.email,
              name: user.name || null,
              image: user.image || null,
            })
            .returning();

          // Create default account for the user
          const [defaultAccount] = await db
            .insert(accounts)
            .values({
              name: `${user.name || user.email}'s Account`,
              type: 'user',
              authType: 'oauth',
              apiKey: generateApiKey(),
              maxConcurrentWorkers: 3,
              ownerId: newUser.id,
            })
            .returning();

          // Create default workspace for the user
          await db.insert(workspaces).values({
            name: 'My Workspace',
            ownerId: newUser.id,
          });

          console.log(`Created new user: ${user.email} with default account and workspace`);
        }

        return true;
      } catch (error) {
        console.error('Error during sign-in user creation:', error);
        return false;
      }
    },
    async jwt({ token, account }) {
      // On initial sign-in, look up the DB user and store their ID
      if (account?.provider === 'google') {
        try {
          const dbUser = await db.query.users.findFirst({
            where: eq(users.googleId, account.providerAccountId),
          });
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
    signIn: '/auth/signin',
    error: '/auth/error',
  },
});
