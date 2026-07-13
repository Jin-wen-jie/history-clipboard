import { describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { ClipboardWatcher } from "./clipboardWatcher";
import { ShutdownCoordinator, type ShutdownDependencies } from "./shutdownCoordinator";

function createDependencies(overrides: Partial<ShutdownDependencies> = {}) {
  const order: string[] = [];
  const deps: ShutdownDependencies = {
    stopSupervisor: vi.fn(async () => {
      order.push("stop-supervisor");
    }),
    stopWatcher: vi.fn(() => {
      order.push("stop-watcher");
    }),
    drainWatcher: vi.fn(async () => {
      order.push("drain-watcher");
    }),
    flushStore: vi.fn(async () => {
      order.push("flush-store");
    }),
    unregisterShortcuts: vi.fn(() => {
      order.push("unregister-shortcuts");
    }),
    quit: vi.fn(() => {
      order.push("quit");
    }),
    onError: vi.fn(),
    ...overrides
  };
  return { deps, order };
}

describe("ShutdownCoordinator", () => {
  test("prevents the first quit and cleans up in strict order", async () => {
    const { deps, order } = createDependencies();
    const coordinator = new ShutdownCoordinator(deps);
    const event = { preventDefault: vi.fn() };

    expect(coordinator.isQuitting).toBe(false);
    coordinator.handleBeforeQuit(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(coordinator.isQuitting).toBe(true);
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1));
    expect(order).toEqual([
      "stop-supervisor",
      "stop-watcher",
      "drain-watcher",
      "flush-store",
      "unregister-shortcuts",
      "quit"
    ]);
  });

  test("prevents reentrant quits while running without starting another chain", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps } = createDependencies({ stopSupervisor: vi.fn(() => gate) });
    const coordinator = new ShutdownCoordinator(deps);
    const first = { preventDefault: vi.fn() };
    const repeated = { preventDefault: vi.fn() };

    coordinator.handleBeforeQuit(first);
    coordinator.handleBeforeQuit(repeated);

    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(repeated.preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.stopSupervisor).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1));

    const completed = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(completed);
    expect(completed.preventDefault).not.toHaveBeenCalled();
    expect(deps.stopSupervisor).toHaveBeenCalledTimes(1);
  });

  test("blocks synchronous reentry from the first shutdown dependency", async () => {
    let coordinator!: ShutdownCoordinator;
    let reentered = false;
    const nestedEvent = { preventDefault: vi.fn() };
    const { deps } = createDependencies({
      stopSupervisor: vi.fn(async () => {
        if (!reentered) {
          reentered = true;
          coordinator.handleBeforeQuit(nestedEvent);
        }
      })
    });
    coordinator = new ShutdownCoordinator(deps);

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled());

    expect(nestedEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.stopSupervisor).toHaveBeenCalledTimes(1);
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  test("marks shutdown complete before quit can synchronously reenter", async () => {
    let coordinator!: ShutdownCoordinator;
    const nestedEvent = { preventDefault: vi.fn() };
    const { deps } = createDependencies({
      quit: vi.fn(() => coordinator.handleBeforeQuit(nestedEvent))
    });
    coordinator = new ShutdownCoordinator(deps);

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1));

    expect(nestedEvent.preventDefault).not.toHaveBeenCalled();
  });

  test("reports every failed step and still attempts all later cleanup", async () => {
    const failures = Array.from({ length: 6 }, (_, index) => new Error(`failure-${index}`));
    const order: string[] = [];
    const fail = (name: string, error: Error) => () => {
      order.push(name);
      throw error;
    };
    const deps: ShutdownDependencies = {
      stopSupervisor: vi.fn(fail("stop-supervisor", failures[0])),
      stopWatcher: vi.fn(fail("stop-watcher", failures[1])),
      drainWatcher: vi.fn(fail("drain-watcher", failures[2])),
      flushStore: vi.fn(fail("flush-store", failures[3])),
      unregisterShortcuts: vi.fn(fail("unregister-shortcuts", failures[4])),
      quit: vi.fn(fail("quit", failures[5])),
      onError: vi.fn()
    };
    const coordinator = new ShutdownCoordinator(deps);

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1));

    expect(order).toEqual([
      "stop-supervisor",
      "stop-watcher",
      "drain-watcher",
      "flush-store",
      "unregister-shortcuts",
      "quit"
    ]);
    expect(vi.mocked(deps.onError).mock.calls.map((call) => call[0])).toEqual(failures);
  });

  test("drains a final accepted native snapshot before flushing and quitting", async () => {
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const persisted: string[] = [];
    const watcher = new ClipboardWatcher({
      getSettings: async () => DEFAULT_SETTINGS,
      readImage: () => undefined,
      readText: () => "",
      addImage: vi.fn(),
      addText: async (text) => {
        await persistGate;
        persisted.push(text);
        return { ok: false as const, reason: "missing" as const };
      }
    });
    const finalCapture = watcher.captureNative({ text: "last-copy" });
    const flushStore = vi.fn(async () => {
      expect(persisted).toEqual(["last-copy"]);
    });
    const quit = vi.fn();
    const coordinator = new ShutdownCoordinator({
      stopSupervisor: async () => undefined,
      stopWatcher: () => watcher.stop(),
      drainWatcher: () => watcher.drain(),
      flushStore,
      unregisterShortcuts: vi.fn(),
      quit,
      onError: vi.fn()
    });

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await Promise.resolve();
    expect(flushStore).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();

    releasePersist();
    await finalCapture;
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(flushStore).toHaveBeenCalledTimes(1);
  });
});
