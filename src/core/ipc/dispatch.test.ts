import { expect, it, vi } from "vitest";
import { requests } from "../../shared/ipc";
import { attachRendererPort, dispatchedRequests, setJobHandlers } from "./server";

type Response = { kind: string; ok: boolean; value?: unknown; error?: { code: string } };

function renderer() {
  let receive: (event: { data: unknown }) => void = () => {};
  let settle: (response: Response) => void = () => {};
  attachRendererPort({
    on: (_event, listener) => {
      receive = listener;
    },
    postMessage: (message) => settle(message as Response),
    start() {},
    close() {},
  });
  return (name: string, input: unknown) =>
    new Promise<Response>((resolve) => {
      settle = resolve;
      receive({ data: { kind: "req", name, input, id: name } });
    });
}

it("dispatches every request the contract names", () => {
  expect(Object.keys(requests).filter((name) => !dispatchedRequests.has(name))).toEqual([]);
  expect([...dispatchedRequests].filter((name) => !(name in requests))).toEqual([]);
});

it("routes by name and keeps the not-ready and not-bound answers", async () => {
  const request = renderer();
  // Nothing answers before the job handlers are bound.
  expect(await request("jobs.list", {})).toMatchObject({ ok: false, error: { code: "not-ready" } });
  const cancel = vi.fn(() => ({}));
  setJobHandlers({ cancel } as never);
  expect(await request("jobs.cancel", { jobId: "j1" })).toMatchObject({ ok: true, value: {} });
  expect(cancel).toHaveBeenCalledWith({ jobId: "j1" });
  expect(await request("jobs.cancel", {})).toMatchObject({ ok: false });
  // A group not bound yet answers nothing, without reading the input; a request with no argument still checks it.
  expect(await request("study.quizStart", {})).toMatchObject({ ok: true, value: undefined });
  expect(await request("study.cardSettings", {})).toMatchObject({ ok: true, value: undefined });
  expect(await request("study.cardSettings", 5)).toMatchObject({ ok: false });
  // An inherited property name is not a route.
  expect(await request("toString", {})).toMatchObject({ ok: false, error: { code: "unknown-request" } });
  expect(await request("nope.nothing", {})).toMatchObject({ ok: false, error: { code: "unknown-request" } });
});
