/**
 * Roles module: a new team gets the default roles (Organizer, Builder,
 * Researcher; lib/default-roles.ts). Fire-and-forget, exactly as the inline
 * call was: team creation never waits on or fails for the seed.
 */
import { subscriber, type AnySubscriber } from '@/lib/core-events';
import { seedDefaultRolesForTeam } from '@/lib/default-roles';

export const roleSubscribers: readonly AnySubscriber[] = [
  subscriber('roles-skills', 'team.created', 'seed-default-roles', e => {
    seedDefaultRolesForTeam(e.teamId).catch(err =>
      console.error('Failed to seed default roles for new team:', err),
    );
  }),
];
