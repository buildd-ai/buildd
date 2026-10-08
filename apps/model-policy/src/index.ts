/**
 * Model-policy Worker: surface + tier in, provider + model + effort out.
 * See README.md and handler.ts.
 */
import { handle, type Env } from './handler';

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
} satisfies ExportedHandler<Env>;
