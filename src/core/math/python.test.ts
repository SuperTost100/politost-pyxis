import { describe, expect, it } from "vitest";
import { runPython } from "./python";
import { receiveRuntimeReply, setRuntimeSender } from "./runtime-client";

type Request = {
  type: string;
  id: string;
  operation: string;
  payload: { code: string; timeoutMs: number };
};
describe("Python runtime transport", () => {
  it("routes concurrent replies by request ID and forwards deadlines", async () => {
    const requests: Request[] = [];
    setRuntimeSender((message) => requests.push(message as Request));
    const first = runPython("print(1)", 1000);
    const second = runPython("while True: pass", 10000);
    expect(
      requests.map((row) => [row.type, row.operation, row.payload]),
    ).toEqual([
      ["runtime-request", "python", { code: "print(1)", timeoutMs: 1000 }],
      [
        "runtime-request",
        "python",
        { code: "while True: pass", timeoutMs: 10000 },
      ],
    ]);
    receiveRuntimeReply({ id: "unrelated", result: {} });
    receiveRuntimeReply({
      id: requests[1]!.id,
      result: {
        stdout: "",
        stderr: "KeyboardInterrupt",
        images: [],
        timedOut: true,
        truncated: false,
      },
    });
    receiveRuntimeReply({
      id: requests[0]!.id,
      result: {
        stdout: "1\n",
        stderr: "",
        images: ["data:image/png;base64,AA=="],
        timedOut: false,
        truncated: false,
      },
    });
    expect(await first).toMatchObject({
      stdout: "1\n",
      images: ["data:image/png;base64,AA=="],
      timedOut: false,
    });
    expect(await second).toMatchObject({ timedOut: true });
  });
  it("returns a runtime error without invoking native Python", async () => {
    setRuntimeSender((message) =>
      receiveRuntimeReply({
        id: (message as Request).id,
        error: "runtime-download-failed",
      }),
    );
    expect(await runPython("print(2)")).toEqual({
      stdout: "",
      stderr: "runtime-download-failed",
      images: [],
      timedOut: false,
      truncated: false,
    });
  });
});
