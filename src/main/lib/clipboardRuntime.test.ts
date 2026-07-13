import { describe, expect, test, vi } from "vitest";
import type { ClipboardBackgroundState } from "../../shared/types";
import type { ClipboardAgentSupervisorOptions } from "./clipboardAgentSupervisor";
import type { NativeClipboardSnapshot } from "./clipboardAgentProtocol";
import type { ClipboardWatcherOptions } from "./clipboardWatcher";
import { ClipboardRuntime } from "./clipboardRuntime";

const STOPPED_STATE: ClipboardBackgroundState = {
  mode: "stopped",
  helperPid: null,
  helperGeneration: 0,
  lastEventAt: null,
  lastSequence: null,
  restartCount: 0,
  nextRestartAt: null,
  gapCount: 0,
  filteredCount: 0,
  queueDepth: 0,
  queueBytes: 0,
  lastExit: null,
  lastError: null
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness() {
  let watcherOptions!: ClipboardWatcherOptions;
  let supervisorOptions!: ClipboardAgentSupervisorOptions;
  const order: string[] = [];
  const watcher = {
    startFallbackPolling: vi.fn(() => order.push("fallback-start")),
    stopFallbackPolling: vi.fn(() => order.push("fallback-stop")),
    stop: vi.fn(() => order.push("watcher-stop")),
    captureNative: vi.fn(async (): Promise<void> => undefined),
    reconcileOnce: vi.fn(async () => undefined),
    drain: vi.fn(async () => undefined),
    getQueueState: vi.fn(() => ({ depth: 0, bytes: 0, backpressured: false }))
  };
  const supervisor = {
    start: vi.fn(() => order.push("supervisor-start")),
    stop: vi.fn(async () => {
      order.push("supervisor-stop");
    }),
    handleSystemResume: vi.fn(),
    setOutputPaused: vi.fn(),
    getStatus: vi.fn(() => ({ ...STOPPED_STATE }))
  };
  const createImageInput = vi.fn((png: Buffer, width: number, height: number) => ({
    png,
    thumbnailPng: Buffer.from([9]),
    width,
    height
  }));
  const onStatusChange = vi.fn();
  const runtime = new ClipboardRuntime({
    helperPath: "C:\\app\\clipboard-listener.exe",
    watcherOptions: {
      getSettings: vi.fn(),
      readImage: vi.fn(),
      readText: vi.fn(),
      addImage: vi.fn(),
      addText: vi.fn()
    },
    createImageInput,
    onStatusChange,
    createWatcher: (options) => {
      watcherOptions = options;
      return watcher as never;
    },
    createSupervisor: (options) => {
      supervisorOptions = options;
      return supervisor as never;
    }
  });

  const emitStatus = (patch: Partial<ClipboardBackgroundState>) => {
    supervisorOptions.onStatusChange({ ...STOPPED_STATE, ...patch });
  };

  return {
    runtime,
    watcher,
    supervisor,
    watcherOptions,
    supervisorOptions,
    createImageInput,
    onStatusChange,
    emitStatus,
    order
  };
}

describe("ClipboardRuntime", () => {
  test("starts fallback before the supervisor and forces one reconcile per ready generation", () => {
    const harness = createHarness();

    harness.runtime.start();
    expect(harness.order).toEqual(["fallback-start", "supervisor-start"]);

    harness.emitStatus({ mode: "listening", helperGeneration: 1 });
    harness.emitStatus({ mode: "listening", helperGeneration: 1, lastSequence: 2 });
    expect(harness.watcher.stopFallbackPolling).toHaveBeenCalledTimes(2);
    expect(harness.watcher.reconcileOnce).toHaveBeenCalledTimes(1);
    expect(harness.watcher.reconcileOnce).toHaveBeenLastCalledWith({ force: true });

    harness.emitStatus({ mode: "starting", helperGeneration: 2 });
    harness.emitStatus({ mode: "listening", helperGeneration: 2 });
    expect(harness.watcher.startFallbackPolling).toHaveBeenCalledTimes(2);
    expect(harness.watcher.reconcileOnce).toHaveBeenCalledTimes(2);
  });

  test("uses ordinary reconcile for heartbeat and gap requests", async () => {
    const harness = createHarness();

    await harness.supervisorOptions.onReconcile();

    expect(harness.watcher.reconcileOnce).toHaveBeenCalledWith();
  });

  test("does not add an ordinary reconcile after a ready force reconcile", async () => {
    const harness = createHarness();
    harness.runtime.start();

    harness.emitStatus({ mode: "listening", helperGeneration: 1 });
    await harness.supervisorOptions.onReconcile();

    expect(harness.watcher.reconcileOnce).toHaveBeenCalledTimes(1);
    expect(harness.watcher.reconcileOnce).toHaveBeenCalledWith({ force: true });
  });

  test("copies native PNG data, defaults missing text, and awaits capture persistence", async () => {
    const harness = createHarness();
    const captureGate = deferred();
    harness.watcher.captureNative.mockReturnValueOnce(captureGate.promise);
    const png = Buffer.from([1, 2, 3]);

    let settled = false;
    const handling = Promise.resolve(harness.supervisorOptions.onSnapshot({
      version: 1,
      type: "snapshot",
      sequence: 1,
      capturedAt: 10,
      png,
      width: 16,
      height: 9
    } as NativeClipboardSnapshot)).then(() => {
      settled = true;
    });

    const copiedPng = harness.createImageInput.mock.calls[0][0];
    expect(copiedPng).not.toBe(png);
    expect(copiedPng).toEqual(Buffer.from([1, 2, 3]));
    png.fill(8);
    expect(copiedPng).toEqual(Buffer.from([1, 2, 3]));
    expect(harness.createImageInput).toHaveBeenCalledWith(copiedPng, 16, 9);
    expect(harness.watcher.captureNative).toHaveBeenCalledWith({
      text: "",
      image: expect.objectContaining({ png: copiedPng, width: 16, height: 9 })
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    captureGate.resolve();
    await handling;
    expect(settled).toBe(true);
  });

  test("maps watcher backpressure and force reconciles only when output resumes", () => {
    const harness = createHarness();

    harness.watcherOptions.onBackpressureChange?.(false);
    harness.watcherOptions.onBackpressureChange?.(true);
    harness.watcherOptions.onBackpressureChange?.(true);
    harness.watcherOptions.onBackpressureChange?.(false);
    harness.watcherOptions.onBackpressureChange?.(false);

    expect(harness.supervisor.setOutputPaused.mock.calls).toEqual([[false], [true], [true], [false], [false]]);
    expect(harness.watcher.reconcileOnce).toHaveBeenCalledTimes(1);
    expect(harness.watcher.reconcileOnce).toHaveBeenCalledWith({ force: true });
  });

  test("notifies the supervisor and force reconciles after system resume", () => {
    const harness = createHarness();

    harness.runtime.handleSystemResume();

    expect(harness.supervisor.handleSystemResume).toHaveBeenCalledTimes(1);
    expect(harness.watcher.reconcileOnce).toHaveBeenCalledWith({ force: true });
  });

  test("logs a fixed error when resume reconciliation rejects", async () => {
    const harness = createHarness();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    harness.watcher.reconcileOnce.mockRejectedValueOnce(new Error("private clipboard data"));

    harness.runtime.handleSystemResume();
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith("Clipboard force reconcile failed");
    });
    expect(error.mock.calls.flat().join(" ")).not.toContain("private clipboard data");
    error.mockRestore();
  });

  test("force reconciles after capture-related settings change", async () => {
    const harness = createHarness();

    await harness.runtime.reconcileAfterSettingsChange();

    expect(harness.watcher.reconcileOnce).toHaveBeenCalledWith({ force: true });
  });

  test("merges queue and filtered counters and returns defensive state copies", () => {
    const harness = createHarness();
    harness.emitStatus({
      mode: "fallback",
      filteredCount: 3,
      lastExit: { code: 7, signal: null }
    });
    harness.watcherOptions.onFiltered?.("sensitive");
    harness.watcherOptions.onFiltered?.("too-large");
    harness.watcherOptions.onQueueStateChange?.({ depth: 4, bytes: 40, backpressured: true });

    const state = harness.runtime.getState();
    expect(state).toMatchObject({
      mode: "fallback",
      filteredCount: 5,
      queueDepth: 4,
      queueBytes: 40,
      lastExit: { code: 7, signal: null }
    });
    state.lastExit!.code = 99;
    expect(harness.runtime.getState().lastExit).toEqual({ code: 7, signal: null });
    expect(harness.onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({
      filteredCount: 5,
      queueDepth: 4,
      queueBytes: 40
    }));
  });

  test("stops producers once in order and ignores late supervisor status", async () => {
    const harness = createHarness();
    const stopGate = deferred();
    harness.supervisor.stop.mockImplementationOnce(async () => {
      harness.order.push("supervisor-stop");
      await stopGate.promise;
    });
    harness.runtime.start();

    const first = harness.runtime.stopProducers();
    const second = harness.runtime.stopProducers();
    harness.emitStatus({ mode: "fallback", helperGeneration: 2 });
    harness.emitStatus({ mode: "listening", helperGeneration: 2 });

    expect(harness.supervisor.stop).toHaveBeenCalledTimes(1);
    expect(harness.watcher.stop).not.toHaveBeenCalled();
    expect(harness.watcher.startFallbackPolling).toHaveBeenCalledTimes(1);
    expect(harness.watcher.reconcileOnce).not.toHaveBeenCalled();
    stopGate.resolve();
    await Promise.all([first, second]);
    expect(harness.order.slice(-2)).toEqual(["supervisor-stop", "watcher-stop"]);

    await harness.runtime.drain();
    expect(harness.watcher.drain).toHaveBeenCalledTimes(1);
  });
});
