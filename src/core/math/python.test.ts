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
    expect(net.stderr.length).toBeGreaterThan(0);
    expect(net.stdout).not.toContain("Example Domain");
    const flood = await runPython("print('x' * 500000)\n", 4000);
    expect(flood.stdout.length).toBeLessThanOrEqual(200_000);
    expect(flood.truncated).toBe(true);
    const tree = await runPython(
      "import subprocess\nsubprocess.Popen(['sleep', '30'])\nprint('started')\n",
      800,
    );
    expect(tree.timedOut).toBe(true);
  }, 20_000);
});
