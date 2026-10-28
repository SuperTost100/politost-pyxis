import { handle } from "./reports";

// The Workers runtime accepts only handlers as a module's exports, so everything else lives in reports.ts.
export default {
  fetch(request, env) {
    return handle(request, env);
  },
} satisfies ExportedHandler<Env>;
