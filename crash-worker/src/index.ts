import { handle } from "./reports";
import { deleteExpired } from "./retention";

// The Workers runtime accepts only handlers as a module's exports, so everything else lives in reports.ts and
// retention.ts.
export default {
  fetch(request, env) {
    return handle(request, env);
  },
  // The daily cron in wrangler.jsonc: deletes reports older than 90 days, behind the bucket's lifecycle rule.
  scheduled(controller, env, ctx) {
    ctx.waitUntil(
      deleteExpired(env.REPORTS, new Date(controller.scheduledTime)).then((removed) => {
        if (removed) console.log(`pyxis-crash: deleted ${removed} expired reports`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
