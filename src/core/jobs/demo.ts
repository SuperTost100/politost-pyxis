import { sleep, type JobSpec } from "./runner";

export const demoJob: JobSpec = {
  jobClass: "demo",
  steps: [
    {
      name: "one",
      label: "jobs.demo.one",
      run: (ctx) => sleep(ctx.signal, 350),
    },
    {
      name: "two",
      label: "jobs.demo.two",
      run: async (ctx) => {
        const params = (ctx.params ?? {}) as { failOnce?: boolean };
        if (params.failOnce) {
          ctx.setParams({ ...params, failOnce: false });
          throw new Error("demo-step-failed");
        }
        await sleep(ctx.signal, 350);
      },
    },
    {
      name: "three",
      label: "jobs.demo.three",
      run: (ctx) => sleep(ctx.signal, 350),
    },
  ],
};
