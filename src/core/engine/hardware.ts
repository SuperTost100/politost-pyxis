import { execFile } from "node:child_process";
import { readdir, readFile, statfs } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { dirname, join } from "node:path";

export type GpuVendor = "apple" | "nvidia" | "amd" | "intel" | "other";
export type Gpu = {
  vendor: GpuVendor;
  name: string;
  /** Memory the GPU can use for a model. Unified memory reports the whole RAM. Null when the system did not say. */
  vramBytes: number | null;
  /** Apple Silicon: the GPU shares the computer's memory. */
  unified: boolean;
};
export type Hardware = {
  platform: NodeJS.Platform;
  ramBytes: number;
  /** Free space where Ollama keeps its models, or null when it could not be read. */
  freeDiskBytes: number | null;
  gpus: Gpu[];
  /** False when the system's own GPU query failed or timed out, so an empty list proves nothing. */
  complete: boolean;
};

const MIB = 1024 * 1024;

function vendorOf(text: string): GpuVendor {
  if (/nvidia|geforce|quadro|tesla|rtx/i.test(text)) return "nvidia";
  if (/\bamd\b|radeon|advanced micro devices|\bati\b/i.test(text)) return "amd";
  if (/intel|iris|uhd|arc\b/i.test(text)) return "intel";
  if (/^apple/i.test(text)) return "apple";
  return "other";
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: one line per card, memory in MiB. */
export function parseNvidiaSmi(stdout: string): Gpu[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split(",").map((part) => part.trim()))
    .filter(([name, memory]) => name && memory && /^\d+$/.test(memory))
    .map(([name, memory]) => ({
      vendor: "nvidia" as const,
      name: name!,
      vramBytes: Number(memory) * MIB,
      unified: false,
    }));
}

/** `sysctl -n machdep.cpu.brand_string`. Apple Silicon's GPU uses the computer's memory, so it gets the whole RAM. */
export function parseMacCpu(brand: string, ramBytes: number): Gpu[] {
  const name = brand.trim();
  return /^Apple M\d/i.test(name)
    ? [{ vendor: "apple", name, vramBytes: ramBytes, unified: true }]
    : [];
}

function sizeBytes(text: unknown): number | null {
  const match = /([\d.]+)\s*(GB|MB)/i.exec(String(text ?? ""));
  if (!match) return null;
  return Math.round(
    Number(match[1]) * (match[2]!.toUpperCase() === "GB" ? 1024 : 1) * MIB,
  );
}

/** `system_profiler SPDisplaysDataType -json` on an Intel Mac. Shared graphics memory is not dedicated VRAM. */
export function parseMacDisplays(json: string): Gpu[] {
  const body = JSON.parse(json) as {
    SPDisplaysDataType?: Array<Record<string, unknown>>;
  };
  return (body.SPDisplaysDataType ?? []).map((row) => {
    const name = String(row.sppci_model ?? row._name ?? "");
    const vendor = vendorOf(`${String(row.spdisplays_vendor ?? "")} ${name}`);
    return {
      vendor: vendor === "other" && /apple/i.test(name) ? "apple" : vendor,
      name,
      vramBytes: sizeBytes(row.spdisplays_vram),
      unified: false,
    };
  });
}

/** Reads a registry value PowerShell gives as a number, or as little-endian bytes for older drivers. */
function registryBytes(value: unknown): number | null {
  if (typeof value === "number" && value > 0) return value;
  if (Array.isArray(value) && value.every((byte) => typeof byte === "number"))
    return (
      value.reduceRight((sum: number, byte: number) => sum * 256 + byte, 0) ||
      null
    );
  return null;
}

const many = <T>(value: T | T[] | undefined | null): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

/**
 * The output of `windowsScript`. `Win32_VideoController.AdapterRAM` is a 32-bit field that stops at 4 GB, so the
 * driver's 64-bit `HardwareInformation.qwMemorySize` in the registry wins when it names the same card.
 */
export function parseWindowsVideo(json: string): Gpu[] {
  const body = JSON.parse(json) as {
    registry?: unknown;
    adapters?: unknown;
  };
  const registry = many(body.registry as Array<Record<string, unknown>>).map(
    (row) => ({
      name: String(row.DriverDesc ?? ""),
      bytes: registryBytes(row.Memory),
    }),
  );
  return many(body.adapters as Array<Record<string, unknown>>)
    .filter(
      (row) =>
        !/basic display|basic render|remote/i.test(String(row.Name ?? "")),
    )
    .map((row) => {
      const name = String(row.Name ?? "");
      const fromRegistry = registry.find(
        (entry) => entry.name === name && entry.bytes,
      )?.bytes;
      const adapterRam = registryBytes(row.AdapterRAM);
      return {
        vendor: vendorOf(`${String(row.AdapterCompatibility ?? "")} ${name}`),
        name,
        vramBytes: fromRegistry ?? adapterRam,
        unified: false,
      };
    });
}

/** Asks for the cards and their memory without elevation. Registry reads under HKLM need no administrator rights. */
export const windowsScript = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$reg = @(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | Select-Object DriverDesc,@{n='Memory';e={$_.'HardwareInformation.qwMemorySize'}})",
  "$cim = @(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,AdapterCompatibility)",
  "@{ registry = $reg; adapters = $cim } | ConvertTo-Json -Depth 3 -Compress",
].join("; ");

const pciVendors: Record<string, GpuVendor> = {
  "0x1002": "amd",
  "0x10de": "nvidia",
  "0x8086": "intel",
};

/** Linux: one `/sys/class/drm/cardN` per GPU. The amdgpu driver reports VRAM in `mem_info_vram_total`; NVIDIA's does not. */
export async function readLinuxDrm(
  root = "/sys/class/drm",
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
  list: (path: string) => Promise<string[]> = (path) => readdir(path),
): Promise<Gpu[]> {
  const cards = (await list(root)).filter((name) => /^card\d+$/.test(name));
  const gpus: Gpu[] = [];
  for (const card of cards) {
    const device = join(root, card, "device");
    const vendorId = (
      await read(join(device, "vendor")).catch(() => "")
    ).trim();
    if (!vendorId) continue;
    const vram = Number(
      (await read(join(device, "mem_info_vram_total")).catch(() => "")).trim(),
    );
    const pci = /PCI_ID=(\S+)/.exec(
      await read(join(device, "uevent")).catch(() => ""),
    )?.[1];
    gpus.push({
      vendor: pciVendors[vendorId.toLowerCase()] ?? "other",
      name: pci ?? card,
      vramBytes: vram > 0 ? vram : null,
      unified: false,
    });
  }
  return gpus;
}

export type Exec = (
  file: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

const run: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });

/** Free bytes on the disk that holds Ollama's models (`OLLAMA_MODELS`, else `~/.ollama/models`), or the nearest folder that exists. */
export async function freeDiskBytes(
  folder = process.env.OLLAMA_MODELS || join(homedir(), ".ollama", "models"),
): Promise<number | null> {
  for (let dir = folder; ; dir = dirname(dir)) {
    try {
      const stats = await statfs(dir);
      return stats.bavail * stats.bsize;
    } catch {
      if (dirname(dir) === dir) return null;
    }
  }
}

type ProbeDeps = {
  platform?: NodeJS.Platform;
  ramBytes?: number;
  exec?: Exec;
  drm?: () => Promise<Gpu[]>;
};

/** RAM and GPUs, read with cheap commands that need no administrator rights. Each command has a time limit. */
export async function probeGpus(
  deps: ProbeDeps = {},
): Promise<Omit<Hardware, "freeDiskBytes">> {
  const platform = deps.platform ?? process.platform;
  const ramBytes = deps.ramBytes ?? totalmem();
  const exec = deps.exec ?? run;
  let complete = true;
  const nvidia =
    platform === "darwin"
      ? []
      : await exec(
          "nvidia-smi",
          ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
          5000,
        )
          .then(parseNvidiaSmi)
          // No NVIDIA driver is the common case, not a failure.
          .catch(() => []);
  let others: Gpu[] = [];
  try {
    if (platform === "darwin") {
      others = parseMacCpu(
        await exec("sysctl", ["-n", "machdep.cpu.brand_string"], 5000),
        ramBytes,
      );
      if (!others.length)
        others = parseMacDisplays(
          await exec("system_profiler", ["SPDisplaysDataType", "-json"], 10000),
        );
    } else if (platform === "win32") {
      others = parseWindowsVideo(
        await exec(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", windowsScript],
          10000,
        ),
      );
    } else {
      others = await (deps.drm ?? (() => readLinuxDrm()))();
    }
  } catch {
    complete = false;
  }
  // nvidia-smi knows NVIDIA memory exactly; the system's own list may not.
  const gpus = [
    ...nvidia,
    ...others.filter((gpu) => gpu.vendor !== "nvidia" || nvidia.length === 0),
  ];
  return { platform, ramBytes, gpus, complete };
}

let gpus: Promise<Omit<Hardware, "freeDiskBytes">> | undefined;

/**
 * This computer's hardware. The GPU query runs once per launch, the first time something asks, never at startup. Free
 * disk space is read again each time, since a download changes it. End-to-end runs may describe a computer in
 * `PYXIS_E2E_HARDWARE`.
 */
export async function hardware(): Promise<Hardware> {
  const fake = process.env.PYXIS_E2E === "1" && process.env.PYXIS_E2E_HARDWARE;
  if (fake) return JSON.parse(fake) as Hardware;
  gpus ??= probeGpus();
  return { ...(await gpus), freeDiskBytes: await freeDiskBytes() };
}
