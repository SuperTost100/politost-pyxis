import { expect, test } from "@playwright/test";
import { descendants } from "./app-exit";

test("the processes left after quitting are Pyxis's, not Windows processes that name a reused parent ID", () => {
  // Windows lists wininit and the services under it with the ID of a parent that exited at boot. Pyxis's main process
  // got that ID later, so going by IDs alone took lsass, svchost and the rest for Pyxis processes.
  const table = [
    { pid: 600, ppid: 532, started: 100, command: "wininit.exe" },
    { pid: 756, ppid: 600, started: 110, command: "services.exe" },
    { pid: 1004, ppid: 600, started: 120, command: "lsass.exe" },
    { pid: 1100, ppid: 756, started: 130, command: "svchost.exe -k RPCSS -p" },
    {
      pid: 532,
      ppid: 400,
      started: 9_000,
      command: "electron.exe out/main/index.js",
    },
    {
      pid: 2100,
      ppid: 532,
      started: 9_100,
      command: "electron.exe --type=renderer",
    },
    {
      pid: 2200,
      ppid: 532,
      started: 9_200,
      command:
        "electron.exe --type=utility --utility-sub-type=node.mojom.NodeService",
    },
    { pid: 2300, ppid: 2200, started: 9_300, command: "python.exe worker.py" },
  ];
  expect(descendants(table, 532).map((proc) => proc.pid)).toEqual([
    532, 2100, 2200, 2300,
  ]);
});

test("on macOS and Linux, where parent IDs are always live, every child counts", () => {
  const table = [
    { pid: 10, ppid: 1, command: "Electron out/main/index.js" },
    { pid: 11, ppid: 10, command: "Electron Helper --type=renderer" },
    { pid: 12, ppid: 11, command: "child of the renderer" },
    { pid: 13, ppid: 1, command: "something else" },
  ];
  expect(descendants(table, 10).map((proc) => proc.pid)).toEqual([10, 11, 12]);
});
