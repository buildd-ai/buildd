/**
 * Migration script to assign existing accounts and workspaces to a user.
 *
 * This script:
 * 1. Finds or creates a user record for the specified email
 * 2. Assigns all existing accounts and workspaces to that user
 *
 * Usage:
 *   ADMIN_EMAIL=you@example.com bun run apps/web/scripts/migrate-to-multitenancy.ts
 */

import { db } from '@buildd/core/db';
import { users, accounts, workspaces } from '@buildd/core/db/schema';
import { eq, isNull } from 'drizzle-orm';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

if (!ADMIN_EMAIL) {
  console.error('Error: ADMIN_EMAIL environment variable is required');
  console.error('Usage: ADMIN_EMAIL=you@example.com bun run apps/web/scripts/migrate-to-multitenancy.ts');
  process.exit(1);
}

async function main() {
  console.log(`Starting multi-tenancy migration for: ${ADMIN_EMAIL}`);

  // Find or create the admin user
  let adminUser = await db.query.users.findFirst({
    where: eq(users.email, ADMIN_EMAIL!),
  });

  if (!adminUser) {
    console.log(`User not found. Creating placeholder user for ${ADMIN_EMAIL}`);
    console.log('Note: The user record will be updated when they sign in with Google.');

    // Create a placeholder user with a temporary googleId
    // This will be updated when they actually sign in
    const [newUser] = await db
      .insert(users)
      .values({
        googleId: `placeholder_${Date.now()}`,
        email: ADMIN_EMAIL!,
        name: 'Admin',
      })
      .returning();

    adminUser = newUser;
    console.log(`Created placeholder user with ID: ${adminUser.id}`);
  } else {
    console.log(`Found existing user: ${adminUser.id}`);
  }

  // Count unassigned accounts and workspaces
  const unassignedAccounts = await db.query.accounts.findMany({
    where: isNull(accounts.ownerId),
  });

  const unassignedWorkspaces = await db.query.workspaces.findMany({
    where: isNull(workspaces.ownerId),
  });

  console.log(`Found ${unassignedAccounts.length} unassigned accounts`);
  console.log(`Found ${unassignedWorkspaces.length} unassigned workspaces`);

  if (unassignedAccounts.length === 0 && unassignedWorkspaces.length === 0) {
    console.log('No unassigned resources found. Migration complete!');
    process.exit(0);
  }

  // Assign accounts to admin user
  if (unassignedAccounts.length > 0) {
    await db
      .update(accounts)
      .set({ ownerId: adminUser.id })
      .where(isNull(accounts.ownerId));
    console.log(`Assigned ${unassignedAccounts.length} accounts to ${ADMIN_EMAIL}`);
  }

  // Assign workspaces to admin user
  if (unassignedWorkspaces.length > 0) {
    await db
      .update(workspaces)
      .set({ ownerId: adminUser.id })
      .where(isNull(workspaces.ownerId));
    console.log(`Assigned ${unassignedWorkspaces.length} workspaces to ${ADMIN_EMAIL}`);
  }

  console.log('\nMigration complete!');
  console.log('Summary:');
  console.log(`  - User ID: ${adminUser.id}`);
  console.log(`  - Accounts assigned: ${unassignedAccounts.length}`);
  console.log(`  - Workspaces assigned: ${unassignedWorkspaces.length}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
