import { handleRequest, runScheduled, type Env } from './handlers.ts';

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
  scheduled: (_controller: ScheduledController, env: Env) => runScheduled(env),
} satisfies ExportedHandler<Env>;
