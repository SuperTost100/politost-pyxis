import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../test-temp";
import { watchFolder } from "./linked-watch";

type Listener = (event: string, name: string | null) => void;

/** A watch that the test drives: `emit` stands for a change the system reports. */
function fakeWatch() {
  let listener: Listener | undefined;
  let onError: ((err: unknown) => void) | undefined;
  const state = { closed: false, recursive: undefined as boolean | undefined };
  const watch = (
    _path: string,
    options: { recursive: boolean; persistent: boolean },
    next: Listener,
  ) => {
    state.recursive = options.recursive;
    listener = next;
    const handle = {
      close: () => {
        state.closed = true;
      },
      on: (_event: string, cb: (err: unknown) => void) => {
        onError = cb;
        return handle;
      },
    };
    return handle as never;
  };
  return {
    watch,
    state,
    emit: (name: string | null = "notes.pdf") => listener?.("rename", name),
    fail: (err: unknown) => onError?.(err),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("folder watch", () => {
  it("runs once after a burst of changes is quiet, and again for the next burst", () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const onChange = vi.fn();
    watchFolder("/study", onChange, { quietMs: 1000, maxWaitMs: 10_000, watch: fake.watch });
    expect(fake.state.recursive).toBe(true);
    for (let index = 0; index < 5; index += 1) {
      fake.emit(`file${index}.pdf`);
      vi.advanceTimersByTime(500);
    }
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    fake.emit();
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("still runs when changes never stop, once the longest wait is over", () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const onChange = vi.fn();
    watchFolder("/study", onChange, { quietMs: 1000, maxWaitMs: 3000, watch: fake.watch });
    for (let elapsed = 0; elapsed < 3000; elapsed += 200) {
      fake.emit();
      vi.advanceTimersByTime(200);
    }
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores hidden files, and stops after close or an error", () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const onChange = vi.fn();
    const onError = vi.fn();
    const watch = watchFolder("/study", onChange, { quietMs: 100, watch: fake.watch, onError });
    fake.emit(".DS_Store");
    fake.emit(join("Fisica", ".~lock.appunti.docx#"));
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
    fake.emit();
    watch.close();
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
    expect(fake.state.closed).toBe(true);

    const second = fakeWatch();
    watchFolder("/study", onChange, { quietMs: 100, watch: second.watch, onError });
    second.emit();
    second.fail(new Error("EMFILE"));
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
    expect(second.state.closed).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("ignores changes inside hidden folders and inside Pyxis's own data, but not a change with no name", () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const onChange = vi.fn();
    // The student linked their home folder, which holds Pyxis's workspace: its own writes must not start another look.
    watchFolder("/home/ada", onChange, {
      quietMs: 100,
      watch: fake.watch,
      exclude: ["/home/ada/Library/Application Support/Pyxis"],
    });
    fake.emit(join("Library", "Application Support", "Pyxis", "workspace", "pyxis.db-wal"));
    fake.emit(join(".config", "Pyxis", "workspace", "pyxis.db"));
    fake.emit(join("Fisica", ".git", "index"));
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
    fake.emit(join("Library", "Fisica.pdf"));
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(1);
    // Some systems name no file: that change still counts.
    fake.emit(null);
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("falls back to watching the top of the folder where recursive watches are unavailable", () => {
    const calls: boolean[] = [];
    const fake = fakeWatch();
    watchFolder("/study", () => {}, {
      watch: (path, options, listener) => {
        calls.push(options.recursive);
        if (options.recursive)
          throw Object.assign(new Error("unavailable"), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
        return fake.watch(path, options, listener);
      },
    });
    expect(calls).toEqual([true, false]);
    const onError = vi.fn();
    watchFolder("/gone", () => {}, {
      onError,
      watch: () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("sees a file added deep in a real folder", async () => {
    const root = tempDir("pyxis-watch-");
    mkdirSync(join(root, "Fisica", "Esami"), { recursive: true });
    const onChange = vi.fn();
    const watch = watchFolder(root, onChange, { quietMs: 50 });
    try {
      // Linux sets up its recursive watch on each folder as it starts, so give it a moment before the change.
      await new Promise((resolve) => setTimeout(resolve, 200));
      writeFileSync(join(root, "Fisica", "Esami", "luglio.pdf"), "x");
      await expect.poll(() => onChange.mock.calls.length, { timeout: 5000 }).toBe(1);
    } finally {
      watch.close();
    }
  });
});
