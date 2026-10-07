import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAbort } from "../../shared/ipc";

const run = vi.fn();
vi.mock("cli-funnel", async (original) => ({
  ...(await original<typeof import("cli-funnel")>()),
  createFunnel: () => ({ run }),
}));

const { runTurn, setScratch } = await import("./funnel");

beforeEach(() => {
  run.mockReset();
  setScratch("/scratch");
});

describe("runTurn", () => {
  it.each(["agent", "antigravity", "claude"] as const)(
    "runs %s with text-only access in the scratch folder",
    async (provider) => {
      run.mockResolvedValueOnce({ text: "ok", model: "m", provider });
      await runTurn({ selection: { provider, model: "m" }, prompt: "hi" });
      expect(run.mock.calls[0]?.[0].selection).toEqual({
        provider,
        model: "m",
        cwd: "/scratch",
        access: "none",
      });
    },
  );

  it("reports a provider failure raised by cancellation as an abort", async () => {
    const controller = new AbortController();
    run.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("context canceled");
    });
    const error = await runTurn({
      selection: { provider: "antigravity", model: "m" },
      prompt: "hi",
      signal: controller.signal,
    }).catch((err: unknown) => err);
    expect(isAbort(error)).toBe(true);
  });

  it("keeps provider failures that were not cancelled", async () => {
    run.mockRejectedValueOnce(new Error("quota"));
    await expect(
      runTurn({ selection: { provider: "agent", model: "m" }, prompt: "hi" }),
    ).rejects.toThrow("quota");
  });
});
