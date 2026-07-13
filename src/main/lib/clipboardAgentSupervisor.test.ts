import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentFrameHeader, NativeClipboardSnapshot } from "./clipboardAgentProtocol";
import {
  ClipboardAgentSupervisor,
  type ClipboardAgentSupervisorOptions
} from "./clipboardAgentSupervisor";

function encodeFrame(header: AgentFrameHeader, payload = Buffer.alloc(0)): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const frameLength = 4 + headerBytes.length + payload.length;
  const frame = Buffer.allocUnsafe(4 + frameLength);
  frame.writeUInt32LE(frameLength, 0);
  frame.writeUInt32LE(headerBytes.length, 4);
  headerBytes.copy(frame, 8);
  payload.copy(frame, 8 + headerBytes.length);
  return frame;
}

function snapshotFrame(
  sequence: number,
  text = `snapshot-${sequence}`,
  png?: Buffer
): Buffer {
  const textBytes = Buffer.from(text, "utf8");
  const payload = png ? Buffer.concat([textBytes, png]) : textBytes;
  return encodeFrame({
    version: 1,
    type: "snapshot",
    sequence,
    capturedAt: 500,
    text: { offset: 0, length: textBytes.length },
    ...(png
      ? { png: { offset: textBytes.length, length: png.length, width: 1, height: 1 } }
      : {})
  }, payload);
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  constructor(readonly pid: number) {
    super();
  }

  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function flushTasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ready(child: FakeChild, sequence = 10): void {
  child.stdout.write(encodeFrame({
    version: 1,
    type: "ready",
    pid: child.pid,
    sequence,
    at: 123
  }));
}

function createSpawnFactory(): {
  children: FakeChild[];
  spawnMock: typeof spawn;
} {
  const children: FakeChild[] = [];
  let nextPid = 100;
  const spawnMock = vi.fn(() => {
    const child = new FakeChild(nextPid);
    nextPid += 1;
    children.push(child);
    return child.asChild();
  }) as unknown as typeof spawn;
  return { children, spawnMock };
}

function createSupervisor(
  overrides: Partial<ClipboardAgentSupervisorOptions> = {}
): ClipboardAgentSupervisor {
  return new ClipboardAgentSupervisor({
    helperPath: "helper.exe",
    onSnapshot: vi.fn(),
    onReconcile: vi.fn(),
    onStatusChange: vi.fn(),
    now: () => Date.now(),
    random: () => 0.5,
    ...overrides
  });
}

describe("ClipboardAgentSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("starts once, trusts the first READY, and reconciles once", async () => {
    const child = new FakeChild(41);
    const spawnMock = vi.fn(() => child.asChild()) as unknown as typeof spawn;
    const onReconcile = vi.fn();
    const supervisor = new ClipboardAgentSupervisor({
      helperPath: "C:\\app\\clipboard-listener.exe",
      onSnapshot: vi.fn(),
      onReconcile,
      onStatusChange: vi.fn(),
      spawn: spawnMock,
      now: () => Date.now(),
      random: () => 0.5
    });

    supervisor.start();
    supervisor.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith("C:\\app\\clipboard-listener.exe", [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    expect(supervisor.getStatus()).toMatchObject({
      mode: "starting",
      helperPid: null,
      helperGeneration: 1
    });

    child.stdout.write(encodeFrame({
      version: 1,
      type: "ready",
      pid: 41,
      sequence: 10,
      at: 123
    }));
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "listening",
      helperPid: 41,
      helperGeneration: 1,
      lastSequence: 10,
      lastEventAt: 1_000
    });
    expect(onReconcile).toHaveBeenCalledTimes(1);

    child.stdout.write(encodeFrame({
      version: 1,
      type: "ready",
      pid: 41,
      sequence: 10,
      at: 999
    }));
    await flushTasks();

    expect(onReconcile).toHaveBeenCalledTimes(1);
  });

  test("deduplicates error and close through one generation failure gate", async () => {
    const children = [new FakeChild(51), new FakeChild(52)];
    let childIndex = 0;
    const spawnMock = vi.fn(() => {
      const child = children[childIndex];
      childIndex += 1;
      return child.asChild();
    }) as unknown as typeof spawn;
    const supervisor = new ClipboardAgentSupervisor({
      helperPath: "helper.exe",
      onSnapshot: vi.fn(),
      onReconcile: vi.fn(),
      onStatusChange: vi.fn(),
      spawn: spawnMock,
      now: () => Date.now(),
      random: () => 0.5
    });

    supervisor.start();
    const first = children[0];
    first.emit("error", new Error("must not escape"));
    first.emit("close", 1, null);

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      nextRestartAt: 1_500,
      lastError: "spawn-error",
      lastExit: { code: 1, signal: null }
    });
    expect(first.kill).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(supervisor.getStatus()).toMatchObject({
      mode: "starting",
      helperGeneration: 2,
      restartCount: 1
    });
  });

  test.each([
    ["snapshot", snapshotFrame(11)],
    ["heartbeat", encodeFrame({ version: 1, type: "heartbeat", sequence: 11, at: 1 })]
  ])("treats a %s before READY as a protocol error", async (_name, frame) => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });

    supervisor.start();
    children[0].stdout.write(frame);
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "protocol-error"
    });
  });

  test("fails a generation when spawn throws without exposing its message", () => {
    const spawnMock = vi.fn(() => {
      throw new Error("secret spawn detail");
    }) as unknown as typeof spawn;
    const supervisor = createSupervisor({ spawn: spawnMock });

    supervisor.start();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      helperGeneration: 1,
      restartCount: 1,
      lastError: "spawn-error"
    });
    expect(JSON.stringify(supervisor.getStatus())).not.toContain("secret spawn detail");
  });

  test("times out the first READY after three seconds", async () => {
    const { spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();

    await vi.advanceTimersByTimeAsync(2_999);
    expect(supervisor.getStatus().mode).toBe("starting");

    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "ready-timeout"
    });
  });

  test("restarts after a clean exit and records only the fixed exit state", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();

    children[0].emit("close", 0, null);
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "helper-exit",
      lastExit: { code: 0, signal: null }
    });
  });

  test.each([
    ["complete stdout", false, "stdout-ended"],
    ["a trailing partial frame", true, "protocol-error"]
  ])("finishes the parser when stdout ends with %s", async (_name, partial, expectedError) => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();
    ready(children[0]);
    await flushTasks();

    if (partial) {
      children[0].stdout.write(encodeFrame({
        version: 1,
        type: "heartbeat",
        sequence: 10,
        at: 1
      }).subarray(0, 5));
    }
    children[0].stdout.end();
    await flushTasks();
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: expectedError
    });
  });

  test("drains complete frames before reporting a trailing partial frame", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const onSnapshot = vi.fn();
    const supervisor = createSupervisor({ spawn: spawnMock, onSnapshot });
    supervisor.start();
    const partial = encodeFrame({
      version: 1,
      type: "heartbeat",
      sequence: 1,
      at: 1
    }).subarray(0, 5);

    children[0].stdout.emit("data", Buffer.concat([
      encodeFrame({
        version: 1,
        type: "ready",
        pid: children[0].pid,
        sequence: 0,
        at: 1
      }),
      snapshotFrame(1),
      partial
    ]));
    children[0].stdout.emit("end");
    await flushTasks();
    await flushTasks();

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }));
    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "protocol-error"
    });
  });

  test.each([
    ["stdout end", "end", "stdout-ended"],
    ["child close", "close", "helper-exit"]
  ] as const)(
    "drains parsed snapshots before failing a generation after %s",
    async (_name, failure, expectedError) => {
      const { children, spawnMock } = createSpawnFactory();
      const onSnapshot = vi.fn();
      const supervisor = createSupervisor({
        spawn: spawnMock,
        onSnapshot
      });
      supervisor.start();

      children[0].stdout.emit("data", Buffer.concat([
        encodeFrame({
          version: 1,
          type: "ready",
          pid: children[0].pid,
          sequence: 0,
          at: 1
        }),
        snapshotFrame(1)
      ]));
      if (failure === "end") {
        children[0].stdout.emit("end");
        children[0].emit("close", 0, null);
      } else {
        children[0].emit("close", 1, null);
      }
      expect(supervisor.getStatus()).toMatchObject({
        mode: "fallback",
        helperGeneration: 1,
        lastError: expectedError
      });
      await flushTasks();
      await flushTasks();

      expect(onSnapshot).toHaveBeenCalledTimes(1);
      expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }));
      expect(supervisor.getStatus()).toMatchObject({
        mode: "fallback",
        restartCount: 1,
        lastError: expectedError,
        lastExit: {
          code: failure === "end" ? 0 : 1,
          signal: null
        }
      });
    }
  );

  test("bounds failure drain when a snapshot handler never settles", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const blocked = deferred();
    const onSnapshot = vi.fn(async () => {
      await blocked.promise;
    });
    const supervisor = createSupervisor({ spawn: spawnMock, onSnapshot });
    supervisor.start();
    ready(children[0], 0);
    await flushTasks();
    children[0].stdout.write(snapshotFrame(1));
    await flushTasks();
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    children[0].stdout.emit("end");
    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      helperGeneration: 1,
      restartCount: 0,
      lastError: "stdout-ended"
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      helperGeneration: 1,
      restartCount: 0
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "stdout-ended"
    });
    await vi.advanceTimersByTimeAsync(500);
    const current = supervisor.getStatus();
    expect(current.helperGeneration).toBe(2);

    blocked.resolve();
    await flushTasks();
    await flushTasks();

    expect(supervisor.getStatus()).toEqual(current);
  });

  test("continues draining parsed snapshots when a handler rejects after stdout ends", async () => {
    const { children, spawnMock } = createSpawnFactory();
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const seen: number[] = [];
    const supervisor = createSupervisor({
      spawn: spawnMock,
      onSnapshot: async (snapshot) => {
        seen.push(snapshot.sequence);
        if (snapshot.sequence === 1) await first;
      }
    });
    supervisor.start();
    ready(children[0], 0);
    await flushTasks();
    children[0].stdout.write(Buffer.concat([snapshotFrame(1), snapshotFrame(2)]));
    await flushTasks();
    expect(seen).toEqual([1]);

    children[0].stdout.emit("end");
    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 0,
      lastError: "stdout-ended"
    });
    rejectFirst(new Error("private callback detail"));
    await flushTasks();
    await flushTasks();

    expect(seen).toEqual([1, 2]);
    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "stdout-ended"
    });
  });

  test("preserves a pending failure when an earlier reconcile rejects late", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const snapshotBlocked = deferred();
    let rejectReconcile!: (error: Error) => void;
    const reconcile = new Promise<void>((_resolve, reject) => {
      rejectReconcile = reject;
    });
    const supervisor = createSupervisor({
      spawn: spawnMock,
      onSnapshot: async () => {
        await snapshotBlocked.promise;
      },
      onReconcile: () => reconcile
    });
    supervisor.start();
    ready(children[0], 0);
    await flushTasks();
    children[0].stdout.write(snapshotFrame(1));
    await flushTasks();

    children[0].stdout.emit("end");
    rejectReconcile(new Error("private reconcile detail"));
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 0,
      lastError: "stdout-ended"
    });

    snapshotBlocked.resolve();
    await flushTasks();
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "stdout-ended"
    });
  });

  test("preserves a pending failure when stderr arrives during drain", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const snapshotBlocked = deferred();
    const supervisor = createSupervisor({
      spawn: spawnMock,
      onSnapshot: async () => {
        await snapshotBlocked.promise;
      }
    });
    supervisor.start();
    ready(children[0], 0);
    await flushTasks();
    children[0].stdout.write(snapshotFrame(1));
    await flushTasks();

    children[0].stdout.emit("end");
    children[0].stderr.emit("data", Buffer.from("private stderr payload"));

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 0,
      lastError: "stdout-ended"
    });

    snapshotBlocked.resolve();
    await flushTasks();
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "stdout-ended"
    });
  });

  test.each(["listener-failed", "too-large"] as const)(
    "keeps draining after a queued helper-%s behind a pending failure",
    async (code) => {
      const { children, spawnMock } = createSpawnFactory();
      const firstBlocked = deferred();
      const seen: number[] = [];
      const errorsAfterFailure: Array<string | null> = [];
      let failurePublished = false;
      const supervisor = createSupervisor({
        spawn: spawnMock,
        onSnapshot: async (snapshot) => {
          seen.push(snapshot.sequence);
          if (snapshot.sequence === 1) await firstBlocked.promise;
        },
        onStatusChange: (status) => {
          if (failurePublished) errorsAfterFailure.push(status.lastError);
        }
      });
      supervisor.start();
      ready(children[0], 0);
      await flushTasks();
      children[0].stdout.write(Buffer.concat([
        snapshotFrame(1),
        encodeFrame({ version: 1, type: "error", code, sequence: 1, at: 1 }),
        snapshotFrame(2)
      ]));
      await flushTasks();
      expect(seen).toEqual([1]);

      failurePublished = true;
      children[0].stdout.emit("end");
      firstBlocked.resolve();
      await flushTasks();
      await flushTasks();
      await flushTasks();

      expect(seen).toEqual([1, 2]);
      expect(errorsAfterFailure.every((error) => error === "stdout-ended")).toBe(true);
      expect(supervisor.getStatus()).toMatchObject({
        mode: "fallback",
        restartCount: 1,
        lastError: "stdout-ended"
      });
    }
  );

  test("keeps draining after a queued protocol error behind a pending failure", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const onSnapshot = vi.fn();
    const supervisor = createSupervisor({ spawn: spawnMock, onSnapshot });
    supervisor.start();

    children[0].stdout.emit("data", Buffer.concat([
      snapshotFrame(1, "before-ready"),
      encodeFrame({
        version: 1,
        type: "ready",
        pid: children[0].pid,
        sequence: 1,
        at: 1
      }),
      snapshotFrame(2)
    ]));
    children[0].stdout.emit("end");
    await flushTasks();
    await flushTasks();
    await flushTasks();

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ sequence: 2 }));
    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "stdout-ended"
    });
  });

  test("stop does not wait for a blocked failure drain", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const blocked = deferred();
    let stop: Promise<void> | null = null;
    let supervisor!: ClipboardAgentSupervisor;
    supervisor = createSupervisor({
      spawn: spawnMock,
      onSnapshot: async () => {
        await blocked.promise;
      },
      onStatusChange: (status) => {
        if (status.mode === "fallback") stop = supervisor.stop();
      }
    });
    supervisor.start();
    ready(children[0], 0);
    await flushTasks();
    children[0].stdout.write(snapshotFrame(1));
    await flushTasks();
    children[0].stdout.emit("end");

    expect(stop).not.toBeNull();
    await stop;

    expect(supervisor.getStatus()).toMatchObject({ mode: "stopped", restartCount: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    blocked.resolve();
    await flushTasks();
    expect(supervisor.getStatus()).toMatchObject({ mode: "stopped", restartCount: 0 });
  });

  test("maps parser exceptions to protocol-error", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();
    const invalidFrame = Buffer.alloc(4);
    invalidFrame.writeUInt32LE(3, 0);

    children[0].stdout.write(invalidFrame);
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "protocol-error"
    });
  });

  test("times out missing heartbeats from the local READY receipt time", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();
    ready(children[0]);
    await flushTasks();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(supervisor.getStatus().mode).toBe("listening");

    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "heartbeat-timeout"
    });
  });

  test("ignores late events from an old generation", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const onSnapshot = vi.fn();
    const supervisor = createSupervisor({ spawn: spawnMock, onSnapshot });
    supervisor.start();
    const first = children[0];
    first.emit("error", new Error("first failure"));
    await vi.advanceTimersByTimeAsync(500);
    const secondStatus = supervisor.getStatus();

    first.stdout.write(snapshotFrame(1, "old"));
    first.emit("error", new Error("late error"));
    first.emit("close", 0, null);
    await flushTasks();

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(supervisor.getStatus()).toEqual(secondStatus);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  test("uses capped exponential backoff while keeping restartCount cumulative", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    const delays = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    supervisor.start();

    for (let index = 0; index < delays.length; index += 1) {
      const failedAt = Date.now();
      children[index].emit("error", new Error("ignored"));
      expect(supervisor.getStatus()).toMatchObject({
        restartCount: index + 1,
        nextRestartAt: failedAt + delays[index]
      });
      await vi.advanceTimersByTimeAsync(delays[index]);
    }

    expect(spawnMock).toHaveBeenCalledTimes(delays.length + 1);
    expect(supervisor.getStatus().restartCount).toBe(delays.length);
  });

  test.each([
    [0, 400],
    [1, 600]
  ])("applies bounded jitter for random=%s", (random, expectedDelay) => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock, random: () => random });
    supervisor.start();

    children[0].emit("error", new Error("ignored"));

    expect(supervisor.getStatus().nextRestartAt).toBe(1_000 + expectedDelay);
  });

  test("resets only the backoff attempt after sixty healthy seconds", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({
      spawn: spawnMock,
      heartbeatTimeoutMs: 100_000
    });
    supervisor.start();
    children[0].emit("error", new Error("first"));
    await vi.advanceTimersByTimeAsync(500);
    ready(children[1]);
    await flushTasks();

    await vi.advanceTimersByTimeAsync(60_000);
    children[1].emit("close", 1, null);
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      restartCount: 2,
      nextRestartAt: Date.now() + 500,
      lastError: "helper-exit"
    });
  });

  test("resets heartbeat timeout from local receipt time", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();
    ready(children[0]);
    await flushTasks();

    await vi.advanceTimersByTimeAsync(10_000);
    children[0].stdout.write(encodeFrame({
      version: 1,
      type: "heartbeat",
      sequence: 10,
      at: 0
    }));
    await flushTasks();

    expect(supervisor.getStatus().lastEventAt).toBe(11_000);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(supervisor.getStatus().mode).toBe("listening");
    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.getStatus().lastError).toBe("heartbeat-timeout");
  });

  test("keeps READY timeout active when output pause is requested before READY", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();
    const pauseSpy = vi.spyOn(children[0].stdout, "pause");
    const resumeSpy = vi.spyOn(children[0].stdout, "resume");

    supervisor.setOutputPaused(true);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(supervisor.getStatus().mode).toBe("starting");
    expect(pauseSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.getStatus().lastError).toBe("ready-timeout");
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  test("suspends heartbeat timeout while paused and pings after resume", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();
    ready(children[0]);
    await flushTasks();
    let stdin = "";
    children[0].stdin.on("data", (chunk: Buffer) => {
      stdin += chunk.toString("utf8");
    });

    supervisor.setOutputPaused(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(supervisor.getStatus().mode).toBe("listening");

    supervisor.setOutputPaused(false);
    expect(stdin).toBe("PING\n");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(supervisor.getStatus().mode).toBe("listening");
    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.getStatus().lastError).toBe("heartbeat-timeout");
  });

  test("resumes only the stdout belonging to the active generation", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();
    ready(children[0]);
    await flushTasks();
    const oldResume = vi.spyOn(children[0].stdout, "resume");
    supervisor.setOutputPaused(true);

    children[0].emit("error", new Error("rotate"));
    expect(oldResume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(children[1].stdout.isPaused()).toBe(false);
    const newResume = vi.spyOn(children[1].stdout, "resume");
    ready(children[1]);
    await flushTasks();
    expect(children[1].stdout.isPaused()).toBe(true);

    supervisor.setOutputPaused(false);

    expect(newResume).toHaveBeenCalledTimes(1);
    expect(oldResume).toHaveBeenCalledTimes(1);
  });

  test("waits for READY before applying paused output to a new generation", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();
    ready(children[0]);
    await flushTasks();
    supervisor.setOutputPaused(true);

    children[0].emit("error", new Error("rotate"));
    await vi.advanceTimersByTimeAsync(500);
    const second = children[1];
    const pauseSpy = vi.spyOn(second.stdout, "pause");

    expect(second.stdout.isPaused()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    ready(second);
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "listening",
      helperGeneration: 2,
      helperPid: second.pid
    });
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(second.stdout.isPaused()).toBe(true);
  });

  test("parses fragmented data and multiple ordered frames", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const snapshots: number[] = [];
    const supervisor = createSupervisor({
      spawn: spawnMock,
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot.sequence);
      }
    });
    supervisor.start();
    const frames = Buffer.concat([
      encodeFrame({ version: 1, type: "ready", pid: children[0].pid, sequence: 0, at: 1 }),
      snapshotFrame(1),
      snapshotFrame(2)
    ]);

    children[0].stdout.write(frames.subarray(0, 7));
    children[0].stdout.write(frames.subarray(7));
    await flushTasks();
    await flushTasks();

    expect(snapshots).toEqual([1, 2]);
    expect(supervisor.getStatus().lastSequence).toBe(2);
  });

  test("classifies duplicate, next, gap, stale, and uint32 wrap snapshots", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const onSnapshot = vi.fn();
    const onReconcile = vi.fn();
    const supervisor = createSupervisor({ spawn: spawnMock, onSnapshot, onReconcile });
    supervisor.start();
    ready(children[0], 10);
    await flushTasks();
    children[0].stdout.write(Buffer.concat([
      snapshotFrame(10),
      snapshotFrame(11),
      snapshotFrame(13),
      snapshotFrame(12)
    ]));
    await flushTasks();
    await flushTasks();

    expect(onSnapshot.mock.calls.map((call) =>
      (call[0] as NativeClipboardSnapshot).sequence))
      .toEqual([11, 13]);
    expect(onReconcile).toHaveBeenCalledTimes(2);
    expect(supervisor.getStatus()).toMatchObject({ lastSequence: 13, gapCount: 1 });

    const firstStop = supervisor.stop();
    children[0].emit("close", 0, null);
    await firstStop;
    const wrapChild = new FakeChild(999);
    const wrapSupervisor = createSupervisor({
      spawn: vi.fn(() => wrapChild.asChild()) as unknown as typeof spawn,
      onSnapshot
    });
    wrapSupervisor.start();
    ready(wrapChild, 0xffff_ffff);
    await flushTasks();
    wrapChild.stdout.write(snapshotFrame(0));
    await flushTasks();

    expect(wrapSupervisor.getStatus().lastSequence).toBe(0);
    expect(onSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ sequence: 0 }));
  });

  test.each(["sequence-advanced", "overflow"] as const)(
    "accepts the expected snapshot after an explicit %s gap",
    async (reason) => {
      const { children, spawnMock } = createSpawnFactory();
      const onSnapshot = vi.fn();
      const onReconcile = vi.fn();
      const supervisor = createSupervisor({ spawn: spawnMock, onSnapshot, onReconcile });
      supervisor.start();
      ready(children[0], 10);
      await flushTasks();

      children[0].stdout.write(Buffer.concat([
        encodeFrame({
          version: 1,
          type: "gap",
          reason,
          fromSequence: 10,
          toSequence: 13,
          dropped: 99,
          at: 1
        }),
        snapshotFrame(13)
      ]));
      await flushTasks();
      await flushTasks();

      expect(onSnapshot).toHaveBeenCalledTimes(1);
      expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ sequence: 13 }));
      expect(onReconcile).toHaveBeenCalledTimes(2);
      expect(supervisor.getStatus()).toMatchObject({ lastSequence: 13, gapCount: 1 });
    }
  );

  test("does not invent an expected snapshot for clipboard-busy gaps", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const onSnapshot = vi.fn();
    const onReconcile = vi.fn();
    const supervisor = createSupervisor({ spawn: spawnMock, onSnapshot, onReconcile });
    supervisor.start();
    ready(children[0], 10);
    await flushTasks();

    children[0].stdout.write(Buffer.concat([
      encodeFrame({
        version: 1,
        type: "gap",
        reason: "clipboard-busy",
        fromSequence: 10,
        toSequence: 13,
        dropped: 0,
        at: 1
      }),
      snapshotFrame(13)
    ]));
    await flushTasks();
    await flushTasks();

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onReconcile).toHaveBeenCalledTimes(2);
    expect(supervisor.getStatus()).toMatchObject({ lastSequence: 13, gapCount: 1 });
  });

  test("counts a changed heartbeat as one gap and ignores repeats and stale values", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const onReconcile = vi.fn();
    const supervisor = createSupervisor({ spawn: spawnMock, onReconcile });
    supervisor.start();
    ready(children[0], 10);
    await flushTasks();

    children[0].stdout.write(Buffer.concat([
      encodeFrame({ version: 1, type: "heartbeat", sequence: 11, at: 1 }),
      encodeFrame({ version: 1, type: "heartbeat", sequence: 11, at: 2 }),
      encodeFrame({ version: 1, type: "heartbeat", sequence: 9, at: 3 })
    ]));
    await flushTasks();
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({ lastSequence: 11, gapCount: 1 });
    expect(onReconcile).toHaveBeenCalledTimes(2);
  });

  test("serializes async snapshots and never reenters the handler", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const firstBlocked = deferred();
    const received: NativeClipboardSnapshot[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const onSnapshot = vi.fn(async (snapshot: NativeClipboardSnapshot) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      received.push(snapshot);
      if (snapshot.sequence === 1) await firstBlocked.promise;
      inFlight -= 1;
    });
    const supervisor = createSupervisor({ spawn: spawnMock, onSnapshot });
    supervisor.start();
    ready(children[0], 0);
    await flushTasks();
    children[0].stdout.write(Buffer.concat([
      snapshotFrame(1, "first", Buffer.from([1, 2, 3])),
      snapshotFrame(2, "second", Buffer.from([4, 5, 6]))
    ]));
    await flushTasks();

    expect(received.map((snapshot) => snapshot.sequence)).toEqual([1]);
    expect(maxInFlight).toBe(1);
    received[0].png![0] = 99;

    firstBlocked.resolve();
    await flushTasks();
    await flushTasks();

    expect(received.map((snapshot) => snapshot.sequence)).toEqual([1, 2]);
    expect(received[1].png).toEqual(Buffer.from([4, 5, 6]));
    expect(maxInFlight).toBe(1);
  });

  test.each(["close", "end"] as const)(
    "ignores an old generation snapshot rejection after %s rotation",
    async (failure) => {
      const { children, spawnMock } = createSpawnFactory();
      const blocked = deferred();
      const supervisor = createSupervisor({
        spawn: spawnMock,
        onSnapshot: async () => {
          await blocked.promise;
          throw new Error("late snapshot rejection");
        }
      });
      supervisor.start();
      ready(children[0], 0);
      await flushTasks();
      children[0].stdout.write(snapshotFrame(1));
      await flushTasks();

      if (failure === "close") {
        children[0].emit("close", 1, null);
      } else {
        children[0].stdout.end();
      }
      await flushTasks();
      await vi.advanceTimersByTimeAsync(1_500);
      const current = supervisor.getStatus();
      blocked.resolve();
      await flushTasks();
      await flushTasks();

      expect(supervisor.getStatus()).toEqual(current);
      expect(supervisor.getStatus().helperGeneration).toBe(2);
    }
  );

  test("fails the active generation with a fixed snapshot handler error", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({
      spawn: spawnMock,
      onSnapshot: async () => {
        throw new Error("private callback detail");
      }
    });
    supervisor.start();
    ready(children[0], 0);
    await flushTasks();

    children[0].stdout.write(snapshotFrame(1));
    await flushTasks();
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "snapshot-handler-failed"
    });
    expect(JSON.stringify(supervisor.getStatus())).not.toContain("private callback detail");
  });

  test("starts with the complete stopped background state", () => {
    const supervisor = createSupervisor();

    expect(supervisor.getStatus()).toEqual({
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
    });
  });

  test("fails only listener-failed helper errors", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();
    ready(children[0]);
    await flushTasks();

    children[0].stdout.write(encodeFrame({
      version: 1,
      type: "error",
      code: "listener-failed",
      sequence: 10,
      at: 1
    }));
    await flushTasks();

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      restartCount: 1,
      lastError: "helper-listener-failed"
    });
  });

  test.each(["too-large", "clipboard-busy", "internal"] as const)(
    "records helper-%s and reconciles without emitting content or restarting",
    async (code) => {
      const { children, spawnMock } = createSpawnFactory();
      const onSnapshot = vi.fn();
      const onReconcile = vi.fn();
      const supervisor = createSupervisor({ spawn: spawnMock, onSnapshot, onReconcile });
      supervisor.start();
      ready(children[0]);
      await flushTasks();

      children[0].stdout.write(encodeFrame({
        version: 1,
        type: "error",
        code,
        sequence: 10,
        at: 1
      }));
      await flushTasks();

      expect(supervisor.getStatus()).toMatchObject({
        mode: "listening",
        restartCount: 0,
        lastError: `helper-${code}`
      });
      expect(onSnapshot).not.toHaveBeenCalled();
      expect(onReconcile).toHaveBeenCalledTimes(2);
    }
  );

  test("maps arbitrary stderr bytes to helper-stderr without logging them", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();

    children[0].stderr.write(Buffer.from("private stderr payload"));
    await flushTasks();

    expect(supervisor.getStatus().lastError).toBe("helper-stderr");
    expect(JSON.stringify(supervisor.getStatus())).not.toContain("private stderr payload");
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    consoleError.mockRestore();
    consoleLog.mockRestore();
  });

  test("defensively copies getStatus and status callback values", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const seen: string[] = [];
    const onStatusChange = vi.fn((status) => {
      seen.push(status.mode);
      status.mode = "paused";
      status.helperGeneration = 999;
      if (status.lastExit) status.lastExit.code = 999;
      return Promise.reject(new Error("ignored status callback"));
    });
    const supervisor = createSupervisor({ spawn: spawnMock, onStatusChange });
    supervisor.start();

    expect(supervisor.getStatus()).toMatchObject({ mode: "starting", helperGeneration: 1 });
    children[0].emit("close", 7, "SIGTERM");
    await flushTasks();
    const exposed = supervisor.getStatus();
    exposed.mode = "paused";
    exposed.helperGeneration = 88;
    exposed.lastExit!.code = 88;

    expect(supervisor.getStatus()).toMatchObject({
      mode: "fallback",
      helperGeneration: 1,
      lastExit: { code: 7, signal: "SIGTERM" }
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  test("honors a reentrant stop from the starting status before spawning", async () => {
    const { spawnMock } = createSpawnFactory();
    let supervisor!: ClipboardAgentSupervisor;
    supervisor = createSupervisor({
      spawn: spawnMock,
      onStatusChange: (status) => {
        if (status.mode === "starting") void supervisor.stop();
      }
    });

    supervisor.start();
    await flushTasks();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(supervisor.getStatus().mode).toBe("stopped");
  });

  test("does not leave a restart timer when a fallback status callback stops", async () => {
    const { children, spawnMock } = createSpawnFactory();
    let supervisor!: ClipboardAgentSupervisor;
    supervisor = createSupervisor({
      spawn: spawnMock,
      onStatusChange: (status) => {
        if (status.mode === "fallback") void supervisor.stop();
      }
    });
    supervisor.start();

    children[0].emit("error", new Error("fail"));
    await flushTasks();

    expect(supervisor.getStatus().mode).toBe("stopped");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("resolves stop before a stopped status callback starts again", async () => {
    const { children, spawnMock } = createSpawnFactory();
    let supervisor!: ClipboardAgentSupervisor;
    let restarted = false;
    supervisor = createSupervisor({
      spawn: spawnMock,
      onStatusChange: (status) => {
        if (!restarted && status.mode === "stopped" && status.helperPid === null) {
          restarted = true;
          supervisor.start();
        }
      }
    });
    supervisor.start();
    ready(children[0]);
    await flushTasks();
    let stopped = false;
    const stop = supervisor.stop().then(() => {
      stopped = true;
    });

    children[0].emit("close", 0, null);
    await flushTasks();

    expect(stopped).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await stop;
  });

  test("contains reconcile throws and rejects with a fixed status error", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const synchronous = createSupervisor({
      spawn: spawnMock,
      onReconcile: () => {
        throw new Error("sync private detail");
      }
    });
    synchronous.start();
    ready(children[0]);
    await flushTasks();

    expect(synchronous.getStatus()).toMatchObject({
      mode: "listening",
      lastError: "reconcile-failed",
      restartCount: 0
    });

    const secondFactory = createSpawnFactory();
    const asynchronous = createSupervisor({
      spawn: secondFactory.spawnMock,
      onReconcile: async () => {
        throw new Error("async private detail");
      }
    });
    asynchronous.start();
    ready(secondFactory.children[0]);
    await flushTasks();
    await flushTasks();

    expect(asynchronous.getStatus()).toMatchObject({
      mode: "listening",
      lastError: "reconcile-failed",
      restartCount: 0
    });
  });

  test("stop is idempotent before start", async () => {
    const supervisor = createSupervisor();

    const first = supervisor.stop();
    const second = supervisor.stop();

    expect(first).toBe(second);
    await first;
    expect(supervisor.getStatus().mode).toBe("stopped");
  });

  test.each([false, true])(
    "stops a %s helper with SHUTDOWN and no later restart",
    async (enterRunning) => {
      const { children, spawnMock } = createSpawnFactory();
      const supervisor = createSupervisor({ spawn: spawnMock });
      supervisor.start();
      if (enterRunning) {
        ready(children[0]);
        await flushTasks();
      }
      let stdin = "";
      children[0].stdin.on("data", (chunk: Buffer) => {
        stdin += chunk.toString("utf8");
      });
      const resumeSpy = vi.spyOn(children[0].stdout, "resume");
      supervisor.setOutputPaused(true);

      const first = supervisor.stop();
      const second = supervisor.stop();

      expect(first).toBe(second);
      expect(stdin).toBe("SHUTDOWN\n");
      expect(resumeSpy).toHaveBeenCalledTimes(enterRunning ? 1 : 0);
      children[0].emit("close", 0, null);
      await first;
      children[0].emit("error", new Error("late"));
      children[0].stdout.write(snapshotFrame(99));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(supervisor.getStatus()).toMatchObject({
        mode: "stopped",
        helperPid: null,
        restartCount: 0
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    }
  );

  test("stops immediately from backoff and clears the restart timer", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();
    children[0].emit("error", new Error("backoff"));
    expect(supervisor.getStatus().mode).toBe("fallback");

    const stop = supervisor.stop();
    await stop;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(supervisor.getStatus()).toMatchObject({ mode: "stopped", nextRestartAt: null });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test("bounds stop at four seconds when the helper never closes", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.start();
    let settled = false;
    const stop = supervisor.stop().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(3_999);
    expect(settled).toBe(false);
    expect(children[0].kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await stop;
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatus().mode).toBe("stopped");
  });

  test("resets heartbeat and reconciles once after system resume", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const onReconcile = vi.fn();
    const supervisor = createSupervisor({ spawn: spawnMock, onReconcile });
    supervisor.start();
    ready(children[0]);
    await flushTasks();
    await vi.advanceTimersByTimeAsync(10_000);

    supervisor.handleSystemResume();

    expect(onReconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(supervisor.getStatus().mode).toBe("listening");
    await vi.advanceTimersByTimeAsync(1);
    expect(supervisor.getStatus().lastError).toBe("heartbeat-timeout");
  });

  test("system resume does not spawn while stopped, starting, or backing off", async () => {
    const { children, spawnMock } = createSpawnFactory();
    const supervisor = createSupervisor({ spawn: spawnMock });
    supervisor.handleSystemResume();
    expect(spawnMock).not.toHaveBeenCalled();

    supervisor.start();
    supervisor.handleSystemResume();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    children[0].emit("error", new Error("backoff"));
    supervisor.handleSystemResume();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });
});
