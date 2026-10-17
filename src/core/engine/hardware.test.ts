import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  freeDiskBytes,
  parseMacCpu,
  parseMacDisplays,
  parseNvidiaSmi,
  parseWindowsVideo,
  probeGpus,
  readLinuxDrm,
  windowsScript,
  type Exec,
} from "./hardware";

const GIB = 1024 ** 3;

// Captured from real machines; names and sizes kept, serial-like fields dropped.
const nvidiaSmi =
  "NVIDIA GeForce RTX 3090, 24576\nNVIDIA GeForce GTX 1050, 2048\n";
const intelMacDisplays = JSON.stringify({
  SPDisplaysDataType: [
    {
      _name: "Intel UHD Graphics 630",
      spdisplays_vendor: "sppci_vendor_intel",
      spdisplays_vram_shared: "1536 MB",
      sppci_model: "Intel UHD Graphics 630",
    },
    {
      _name: "AMD Radeon Pro 5500M",
      spdisplays_vendor: "sppci_vendor_amd",
      spdisplays_vram: "8 GB",
      sppci_model: "AMD Radeon Pro 5500M",
    },
  ],
});
const windowsVideo = JSON.stringify({
  registry: [
    { DriverDesc: "NVIDIA GeForce RTX 3060", Memory: 12884901888 },
    { DriverDesc: "Intel(R) UHD Graphics 770", Memory: null },
    { DriverDesc: "AMD Radeon RX 6800", Memory: [0, 0, 0, 0, 4, 0, 0, 0] },
  ],
  adapters: [
    {
      Name: "NVIDIA GeForce RTX 3060",
      AdapterRAM: 4293918720,
      AdapterCompatibility: "NVIDIA",
    },
    {
      Name: "Intel(R) UHD Graphics 770",
      AdapterRAM: 1073741824,
      AdapterCompatibility: "Intel Corporation",
    },
    {
      Name: "AMD Radeon RX 6800",
      AdapterRAM: 4293918720,
      AdapterCompatibility: "Advanced Micro Devices, Inc.",
    },
    {
      Name: "Microsoft Basic Display Adapter",
      AdapterRAM: 0,
      AdapterCompatibility: "(Standard display types)",
    },
  ],
});

describe("hardware parsing", () => {
  it("reads every NVIDIA card and its memory from nvidia-smi", () => {
    expect(parseNvidiaSmi(nvidiaSmi)).toEqual([
      {
        vendor: "nvidia",
        name: "NVIDIA GeForce RTX 3090",
        vramBytes: 24 * GIB,
        unified: false,
      },
      {
        vendor: "nvidia",
        name: "NVIDIA GeForce GTX 1050",
        vramBytes: 2 * GIB,
        unified: false,
      },
    ]);
    expect(parseNvidiaSmi("NVIDIA-SMI has failed\n")).toEqual([]);
  });

  it("gives Apple Silicon the whole unified memory and leaves Intel Macs to system_profiler", () => {
    expect(parseMacCpu("Apple M2 Pro\n", 16 * GIB)).toEqual([
      {
        vendor: "apple",
        name: "Apple M2 Pro",
        vramBytes: 16 * GIB,
        unified: true,
      },
    ]);
    expect(
      parseMacCpu("Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz", 16 * GIB),
    ).toEqual([]);
    expect(parseMacDisplays(intelMacDisplays)).toEqual([
      {
        vendor: "intel",
        name: "Intel UHD Graphics 630",
        vramBytes: null,
        unified: false,
      },
      {
        vendor: "amd",
        name: "AMD Radeon Pro 5500M",
        vramBytes: 8 * GIB,
        unified: false,
      },
    ]);
  });

  it("prefers the driver's 64-bit memory size on Windows over the 4 GB AdapterRAM", () => {
    expect(parseWindowsVideo(windowsVideo)).toEqual([
      {
        vendor: "nvidia",
        name: "NVIDIA GeForce RTX 3060",
        vramBytes: 12 * GIB,
        unified: false,
      },
      {
        vendor: "intel",
        name: "Intel(R) UHD Graphics 770",
        vramBytes: GIB,
        unified: false,
      },
      {
        vendor: "amd",
        name: "AMD Radeon RX 6800",
        vramBytes: 16 * GIB,
        unified: false,
      },
    ]);
    // PowerShell writes a lone adapter as an object, not a list.
    expect(
      parseWindowsVideo(
        JSON.stringify({
          registry: null,
          adapters: { Name: "AMD Radeon RX 580", AdapterRAM: 4293918720 },
        }),
      ),
    ).toEqual([
      {
        vendor: "amd",
        name: "AMD Radeon RX 580",
        vramBytes: 4293918720,
        unified: false,
      },
    ]);
    expect(windowsScript).toContain("qwMemorySize");
    expect(windowsScript).not.toMatch(/RunAs|Start-Process/);
  });

  it("reads amdgpu VRAM from sysfs on Linux and skips the display connectors", async () => {
    const root = mkdtempSync(join(tmpdir(), "pyxis-drm-"));
    try {
      const card = (name: string, files: Record<string, string>) => {
        mkdirSync(join(root, name, "device"), { recursive: true });
        for (const [file, text] of Object.entries(files))
          writeFileSync(join(root, name, "device", file), text);
      };
      // An RX 6900 XT as amdgpu reports it.
      card("card0", {
        vendor: "0x1002\n",
        mem_info_vram_total: "17163091968\n",
        uevent: "DRIVER=amdgpu\nPCI_CLASS=30000\nPCI_ID=1002:73BF\n",
      });
      card("card1", {
        vendor: "0x10de\n",
        uevent: "DRIVER=nvidia\nPCI_ID=10DE:2204\n",
      });
      mkdirSync(join(root, "card0-DP-1"));
      mkdirSync(join(root, "renderD128"));
      expect(await readLinuxDrm(root)).toEqual([
        {
          vendor: "amd",
          name: "1002:73BF",
          vramBytes: 17163091968,
          unified: false,
        },
        {
          vendor: "nvidia",
          name: "10DE:2204",
          vramBytes: null,
          unified: false,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads free space on the nearest folder that exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "pyxis-disk-"));
    try {
      const free = await freeDiskBytes(join(root, "not", "there", "models"));
      expect(free).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GPU probe", () => {
  const fakeExec =
    (outputs: Record<string, string | Error>): Exec =>
    async (file) => {
      const output = outputs[file];
      if (output === undefined || output instanceof Error)
        throw output ?? new Error(`spawn ${file} ENOENT`);
      return output;
    };

  it("uses nvidia-smi for NVIDIA memory and the system list for the rest", async () => {
    const result = await probeGpus({
      platform: "linux",
      ramBytes: 32 * GIB,
      exec: fakeExec({ "nvidia-smi": "NVIDIA GeForce RTX 4080, 16376\n" }),
      drm: async () => [
        {
          vendor: "nvidia",
          name: "10DE:2704",
          vramBytes: null,
          unified: false,
        },
        { vendor: "intel", name: "8086:A780", vramBytes: null, unified: false },
      ],
    });
    expect(result.complete).toBe(true);
    expect(result.gpus.map((gpu) => [gpu.vendor, gpu.vramBytes])).toEqual([
      ["nvidia", 16376 * 1024 * 1024],
      ["intel", null],
    ]);
  });

  it("asks sysctl first on a Mac and never runs nvidia-smi there", async () => {
    const calls: string[] = [];
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args].join(" "));
      return "Apple M3\n";
    };
    const result = await probeGpus({
      platform: "darwin",
      ramBytes: 24 * GIB,
      exec,
    });
    expect(calls).toEqual(["sysctl -n machdep.cpu.brand_string"]);
    expect(result.gpus).toEqual([
      { vendor: "apple", name: "Apple M3", vramBytes: 24 * GIB, unified: true },
    ]);
  });

  it("reports an incomplete probe when PowerShell times out, without throwing", async () => {
    const timeout = Object.assign(new Error("timed out"), { killed: true });
    const result = await probeGpus({
      platform: "win32",
      ramBytes: 16 * GIB,
      exec: fakeExec({ "powershell.exe": timeout }),
    });
    expect(result).toEqual({
      platform: "win32",
      ramBytes: 16 * GIB,
      gpus: [],
      complete: false,
    });
  });

  it("reads Windows cards through PowerShell with a time limit", async () => {
    const seen: Array<[string, number]> = [];
    const exec: Exec = async (file, _args, timeoutMs) => {
      seen.push([file, timeoutMs]);
      if (file === "nvidia-smi") throw new Error("ENOENT");
      return windowsVideo;
    };
    const result = await probeGpus({
      platform: "win32",
      ramBytes: 32 * GIB,
      exec,
    });
    expect(seen).toEqual([
      ["nvidia-smi", 5000],
      ["powershell.exe", 10000],
    ]);
    expect(result.gpus).toHaveLength(3);
  });
});
