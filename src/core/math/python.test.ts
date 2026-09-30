import { describe, expect, it } from "vitest";
import { runPython } from "./python";

describe("runPython", () => {
  it("stops an infinite loop and blocks the network", async () => {
    const hung = await runPython("while True:\n    pass\n", 400);
    expect(hung.timedOut).toBe(true);
    const again = await runPython("print(1 + 1)\n", 4000);
    expect(again.timedOut).toBe(false);
    expect(again.stdout).toContain("2");
    const net = await runPython(
      "import urllib.request\nurllib.request.urlopen('https://example.com')\n",
      4000,
    );
    expect(net.timedOut).toBe(false);
    expect(net.stderr).toMatch(/network blocked|OSError/);
  }, 15_000);
});
