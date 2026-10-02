import { BrowserWindow, dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { mainChannels } from "../shared/bridge";

const fileName = z
  .string()
  .min(1)
  .max(240)
  .refine((s) => !/[\\/\x00-\x1f]/.test(s));
const artifact = z.object({
  filename: fileName.refine((s) => /\.(pyxis|md|csv|apkg)$/i.test(s)),
  base64: z
    .string()
    .max(96 * 1024 * 1024)
    .refine(
      (s) =>
        s.length % 4 === 0 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(s) &&
        Buffer.from(s, "base64").toString("base64") === s,
    ),
});
const pdf = z.object({
  filename: fileName,
  markdown: z.string().max(16 * 1024 * 1024),
});

export function registerArtifactHandlers(
  mainWindow: () => BrowserWindow | null,
  e2eSeam: () => boolean,
): void {
  let printing = false;
  const printJobs = new Map<number, { markdown: string; ready: () => void }>();
  function authorize(senderId: number): void {
    if (senderId !== mainWindow()?.webContents.id)
      throw new Error("export-untrusted-sender");
  }
  async function save(
    filename: string,
    bytes: Buffer,
  ): Promise<"saved" | "cancelled"> {
    const window = mainWindow();
    if (!window || window.isDestroyed()) throw new Error("window-closed");
    const extension = filename.split(".").at(-1)!;
    const forced = e2eSeam() ? process.env["PYXIS_E2E_SAVE"] : undefined;
    const result = forced
      ? { filePath: forced, canceled: false }
      : await dialog.showSaveDialog(window, {
          defaultPath: filename,
          filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
        });
    if (result.canceled || !result.filePath) return "cancelled";
    await writeFile(result.filePath, bytes);
    return "saved";
  }
  ipcMain.handle(mainChannels.artifactSave, async (event, input: unknown) => {
    authorize(event.sender.id);
    const parsed = artifact.parse(input);
    return save(parsed.filename, Buffer.from(parsed.base64, "base64"));
  });
  ipcMain.handle(mainChannels.printData, (event) => {
    const job = printJobs.get(event.sender.id);
    return job ? { markdown: job.markdown } : null;
  });
  ipcMain.handle(mainChannels.printReady, (event) => {
    const job = printJobs.get(event.sender.id);
    if (!job) throw new Error("print-untrusted-sender");
    job.ready();
  });
  ipcMain.handle(mainChannels.pdfExport, async (event, input: unknown) => {
    authorize(event.sender.id);
    const parsed = pdf.parse(input);
    if (printing) throw new Error("print-busy");
    printing = true;
    let printWindow: BrowserWindow;
    try {
      printWindow = new BrowserWindow({
        show: false,
        width: 900,
        height: 1200,
        backgroundColor: "#ffffff",
        webPreferences: {
          preload: join(import.meta.dirname, "../preload/index.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
    } catch (error) {
      printing = false;
      throw error;
    }
    const senderId = printWindow.webContents.id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onFailed: (() => void) | undefined;
    try {
      const ready = new Promise<void>((resolve, reject) => {
        printJobs.set(senderId, { markdown: parsed.markdown, ready: resolve });
        timer = setTimeout(() => reject(new Error("print-timeout")), 30_000);
        onFailed = () => reject(new Error("print-window-closed"));
        printWindow.once("closed", onFailed);
        printWindow.webContents.once("render-process-gone", onFailed);
      });
      // Attach the rejection handler before loading the page; a failed load must
      // not leave an unhandled promise while the window is being disposed.
      const loaded = process.env["ELECTRON_RENDERER_URL"]
        ? printWindow.loadURL(
            `${process.env["ELECTRON_RENDERER_URL"]!.split("#")[0]}#/print`,
          )
        : printWindow.loadFile(
            join(import.meta.dirname, "../renderer/index.html"),
            { hash: "/print" },
          );
      await Promise.all([loaded, ready]);
      if (timer) clearTimeout(timer);
      const bytes = await printWindow.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        pageSize: "A4",
        generateTaggedPDF: true,
        generateDocumentOutline: true,
      });
      return await save(
        parsed.filename.replace(/\.[^.]+$/, "") + ".pdf",
        bytes,
      );
    } finally {
      if (timer) clearTimeout(timer);
      printJobs.delete(senderId);
      if (onFailed) printWindow.removeListener("closed", onFailed);
      if (!printWindow.isDestroyed()) printWindow.destroy();
      printing = false;
    }
  });
}
