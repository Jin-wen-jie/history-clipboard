import { spawn, type ChildProcess } from "node:child_process";
import type { ClipboardBackgroundMode, ClipboardBackgroundState } from "../../shared/types";
import {
  ClipboardAgentFrameParser,
  type AgentFrame,
  type NativeClipboardSnapshot
} from "./clipboardAgentProtocol";
import { classifySequence } from "./clipboardSequence";

export type ClipboardAgentSupervisorOptions = {
  helperPath: string;
  onSnapshot: (snapshot: NativeClipboardSnapshot) => Promise<void> | void;
  onReconcile: () => Promise<void> | void;
  onStatusChange: (status: ClipboardBackgroundState) => void;
  spawn?: typeof spawn;
  now?: () => number;
  random?: () => number;
  readyTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
};

type Phase = "stopped" | "starting" | "running" | "backoff" | "stopping";

type PendingFailure = {
  error: string;
  exit?: { code: number | null; signal: string | null };
};

type GenerationContext = {
  generation: number;
  child: ChildProcess | null;
  parser: ClipboardAgentFrameParser;
  failed: boolean;
  ready: boolean;
  stdoutPaused: boolean;
  stdoutEnded: boolean;
  expectedSnapshotSequence: number | null;
  readyTimer: NodeJS.Timeout | null;
  heartbeatTimer: NodeJS.Timeout | null;
  healthyTimer: NodeJS.Timeout | null;
  failureDrainTimer: NodeJS.Timeout | null;
  pendingFrameCount: number;
  pendingFailure: PendingFailure | null;
  frameChain: Promise<void>;
};

const READY_TIMEOUT_MS = 3_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const HEALTHY_RESET_MS = 60_000;
const FAILURE_DRAIN_TIMEOUT_MS = 1_000;
const STOP_TIMEOUT_MS = 4_000;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

const INITIAL_STATUS: ClipboardBackgroundState = {
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

export class ClipboardAgentSupervisor {
  private readonly helperPath: string;
  private readonly onSnapshot: ClipboardAgentSupervisorOptions["onSnapshot"];
  private readonly onReconcile: ClipboardAgentSupervisorOptions["onReconcile"];
  private readonly onStatusChange: ClipboardAgentSupervisorOptions["onStatusChange"];
  private readonly spawnHelper: typeof spawn;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly readyTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;

  private phase: Phase = "stopped";
  private desiredRunning = false;
  private outputPaused = false;
  private active: GenerationContext | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;
  private backoffAttempt = 0;
  private readonly status: ClipboardBackgroundState = { ...INITIAL_STATUS };

  constructor(options: ClipboardAgentSupervisorOptions) {
    this.helperPath = options.helperPath;
    this.onSnapshot = options.onSnapshot;
    this.onReconcile = options.onReconcile;
    this.onStatusChange = options.onStatusChange;
    this.spawnHelper = options.spawn ?? spawn;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  }

  start(): void {
    if (this.desiredRunning || this.phase !== "stopped") return;

    this.desiredRunning = true;
    this.stopPromise = null;
    this.resolveStop = null;
    this.backoffAttempt = 0;
    this.spawnGeneration();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
    this.desiredRunning = false;
    this.clearRestartTimer();

    if (this.phase === "stopped") {
      this.finishStopPromise();
      return this.stopPromise;
    }

    const context = this.active;
    this.phase = "stopping";
    this.status.mode = this.modeForPhase(this.phase);
    this.status.nextRestartAt = null;
    if (context) {
      this.clearGenerationTimers(context);
      this.clearFailureDrainTimer(context);
      this.resumeStdout(context);
    }
    this.emitStatus();

    if (!context || !this.isCurrent(context) || this.phase !== "stopping") {
      return this.stopPromise;
    }
    if (context.pendingFailure) {
      this.killChild(context);
      this.settleStopped(context);
      return this.stopPromise;
    }
    if (!context?.child || context.failed) {
      this.settleStopped(context);
      return this.stopPromise;
    }

    this.writeCommand(context, "SHUTDOWN\n");
    if (!this.isCurrent(context) || this.phase !== "stopping") return this.stopPromise;
    this.stopTimer = setTimeout(() => {
      if (!this.isCurrent(context) || this.phase !== "stopping") return;
      this.killChild(context);
      this.settleStopped(context);
    }, STOP_TIMEOUT_MS);
    return this.stopPromise;
  }

  handleSystemResume(): void {
    const context = this.active;
    if (
      !this.desiredRunning ||
      this.phase !== "running" ||
      !context ||
      context.failed ||
      !context.ready
    ) {
      return;
    }

    this.armHeartbeatTimer(context, this.now());
    if (!context.stdoutPaused) this.writeCommand(context, "PING\n");
    this.requestReconcile(context);
  }

  setOutputPaused(paused: boolean): void {
    this.outputPaused = paused;
    const context = this.active;
    if (
      !context ||
      context.failed ||
      this.phase !== "running"
    ) {
      return;
    }

    if (paused) {
      if (context.stdoutPaused) return;
      try {
        context.child?.stdout?.pause();
        context.stdoutPaused = true;
      } catch {
        return;
      }
      this.clearTimer(context, "heartbeatTimer");
      return;
    }

    if (!context.stdoutPaused) return;
    this.resumeStdout(context);
    this.armHeartbeatTimer(context, this.now());
    this.writeCommand(context, "PING\n");
  }

  getStatus(): ClipboardBackgroundState {
    return this.copyStatus();
  }

  private spawnGeneration(): void {
    if (!this.desiredRunning || this.phase === "stopping") return;

    const generation = this.status.helperGeneration + 1;
    const context: GenerationContext = {
      generation,
      child: null,
      parser: new ClipboardAgentFrameParser(),
      failed: false,
      ready: false,
      stdoutPaused: false,
      stdoutEnded: false,
      expectedSnapshotSequence: null,
      readyTimer: null,
      heartbeatTimer: null,
      healthyTimer: null,
      failureDrainTimer: null,
      pendingFrameCount: 0,
      pendingFailure: null,
      frameChain: Promise.resolve()
    };
    this.active = context;
    this.phase = "starting";
    this.status.mode = this.modeForPhase(this.phase);
    this.status.helperGeneration = generation;
    this.status.helperPid = null;
    this.status.lastEventAt = null;
    this.status.lastSequence = null;
    this.status.nextRestartAt = null;
    this.emitStatus();
    if (!this.desiredRunning || this.phase !== "starting" || !this.isCurrent(context)) return;

    let child: ChildProcess;
    try {
      child = this.spawnHelper(this.helperPath, [], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      this.failGeneration(context, "spawn-error");
      return;
    }
    if (!this.desiredRunning || this.phase !== "starting" || !this.isCurrent(context)) {
      try {
        child.kill();
      } catch {
        // A reentrant stop completed while spawn was in progress.
      }
      return;
    }
    context.child = child;
    this.attachChild(context, child);

    if (!child.stdin || !child.stdout || !child.stderr) {
      this.failGeneration(context, "spawn-error");
      return;
    }

    this.armReadyTimer(context);
  }

  private attachChild(context: GenerationContext, child: ChildProcess): void {
    child.on("error", () => {
      this.requestGenerationFailure(context, "spawn-error");
    });
    child.on("close", (code, signal) => {
      if (!this.isCurrent(context)) return;
      const exit = {
        code: typeof code === "number" ? code : null,
        signal: typeof signal === "string" ? signal : null
      };
      if (this.phase === "stopping") {
        this.status.lastExit = exit;
        this.settleStopped(context);
        return;
      }
      this.requestGenerationFailure(context, "helper-exit", exit);
    });

    child.stdout?.on("data", (chunk: Buffer | Uint8Array | string) => {
      this.handleStdoutData(context, chunk);
    });
    child.stdout?.on("end", () => {
      this.handleStdoutEnd(context);
    });
    child.stdout?.on("error", () => {
      this.requestGenerationFailure(context, "protocol-error");
    });
    child.stderr?.on("data", () => {
      this.recordFixedError(context, "helper-stderr");
    });
    child.stderr?.on("error", () => {
      this.recordFixedError(context, "helper-stderr");
    });
    child.stdin?.on("error", () => undefined);
  }

  private handleStdoutData(
    context: GenerationContext,
    chunk: Buffer | Uint8Array | string
  ): void {
    if (!this.canProcessFrames(context) || context.stdoutEnded || context.pendingFailure) return;

    let frames: AgentFrame[];
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      frames = context.parser.push(bytes);
    } catch {
      this.failGeneration(context, "protocol-error");
      return;
    }

    const receivedAt = this.now();
    if (
      context.ready &&
      this.phase === "running" &&
      frames.some((frame) => frame.type === "heartbeat")
    ) {
      this.armHeartbeatTimer(context, receivedAt);
    }
    for (const frame of frames) {
      this.enqueue(context, async () => {
        await this.handleFrame(context, frame, receivedAt);
      });
    }
  }

  private handleStdoutEnd(context: GenerationContext): void {
    if (!this.isCurrent(context) || context.failed || context.stdoutEnded) return;
    context.stdoutEnded = true;
    if (this.phase === "stopping") return;

    try {
      context.parser.finish();
    } catch {
      this.requestGenerationFailure(context, "protocol-error");
      return;
    }
    this.requestGenerationFailure(context, "stdout-ended");
  }

  private enqueue(context: GenerationContext, task: () => Promise<void>): void {
    context.pendingFrameCount += 1;
    context.frameChain = context.frameChain
      .then(async () => {
        if (!this.canProcessFrames(context)) return;
        await task();
      })
      .catch(() => {
        this.failGeneration(context, "protocol-error");
      })
      .finally(() => {
        context.pendingFrameCount -= 1;
        if (context.pendingFrameCount === 0) this.finishPendingFailure(context);
      });
  }

  private async handleFrame(
    context: GenerationContext,
    frame: AgentFrame,
    receivedAt: number
  ): Promise<void> {
    if (frame.type === "ready") {
      if (context.ready || this.phase === "running") return;
      if (this.phase !== "starting") return;
      this.acceptReady(context, frame.pid, frame.sequence, receivedAt);
      return;
    }

    if (!context.ready || this.phase !== "running") {
      this.failGeneration(context, "protocol-error");
      return;
    }

    switch (frame.type) {
      case "heartbeat":
        this.acceptHeartbeat(context, frame.sequence, receivedAt);
        return;
      case "snapshot":
        await this.acceptSnapshot(context, frame, receivedAt);
        return;
      case "gap":
        this.acceptGap(context, frame, receivedAt);
        return;
      case "error":
        this.acceptHelperError(context, frame.code, receivedAt);
        return;
    }
  }

  private acceptReady(
    context: GenerationContext,
    pid: number,
    sequence: number,
    receivedAt: number
  ): void {
    const drainingFailure = context.pendingFailure !== null;
    context.ready = true;
    context.expectedSnapshotSequence = null;
    this.clearTimer(context, "readyTimer");
    this.phase = "running";
    if (drainingFailure) {
      this.status.lastSequence = sequence;
      this.status.lastEventAt = receivedAt;
      return;
    }
    this.status.mode = this.modeForPhase(this.phase);
    this.status.helperPid = pid;
    this.status.lastSequence = sequence;
    this.status.lastEventAt = receivedAt;
    this.status.lastError = null;
    if (this.outputPaused) this.setOutputPaused(true);
    this.armHeartbeatTimer(context, receivedAt);
    this.armHealthyTimer(context, receivedAt);
    this.emitStatus();
    this.requestReconcile(context);
  }

  private acceptHeartbeat(
    context: GenerationContext,
    sequence: number,
    receivedAt: number
  ): void {
    const previous = this.status.lastSequence;
    if (previous === null) return;
    const change = classifySequence(previous, sequence);
    if (change.kind === "stale") return;

    this.armHeartbeatTimer(context, receivedAt);
    this.status.lastEventAt = receivedAt;
    if (change.kind !== "duplicate") {
      this.status.lastSequence = sequence;
      this.status.gapCount += 1;
      context.expectedSnapshotSequence = null;
      this.requestReconcile(context);
    }
    this.emitStatus();
  }

  private async acceptSnapshot(
    context: GenerationContext,
    snapshot: NativeClipboardSnapshot,
    receivedAt: number
  ): Promise<void> {
    const previous = this.status.lastSequence;
    if (previous === null) return;
    const change = classifySequence(previous, snapshot.sequence);
    const isExpected = context.expectedSnapshotSequence === snapshot.sequence;
    if (change.kind === "stale" || (change.kind === "duplicate" && !isExpected)) return;

    context.expectedSnapshotSequence = null;
    this.status.lastSequence = snapshot.sequence;
    this.status.lastEventAt = receivedAt;
    if (change.kind === "gap") {
      this.status.gapCount += 1;
      this.requestReconcile(context);
    }
    this.emitStatus();

    if (!this.canProcessFrames(context)) return;
    const copy: NativeClipboardSnapshot = {
      ...snapshot,
      ...(snapshot.png ? { png: Buffer.from(snapshot.png) } : {})
    };
    try {
      await this.onSnapshot(copy);
    } catch {
      if (this.canProcessFrames(context)) {
        this.requestGenerationFailure(context, "snapshot-handler-failed");
      }
    }
  }

  private acceptGap(
    context: GenerationContext,
    frame: Extract<AgentFrame, { type: "gap" }>,
    receivedAt: number
  ): void {
    this.status.gapCount += 1;
    this.status.lastSequence = frame.toSequence;
    this.status.lastEventAt = receivedAt;
    context.expectedSnapshotSequence = frame.reason === "clipboard-busy"
      ? null
      : frame.toSequence;
    this.emitStatus();
    this.requestReconcile(context);
  }

  private acceptHelperError(
    context: GenerationContext,
    code: Extract<AgentFrame, { type: "error" }>["code"],
    receivedAt: number
  ): void {
    this.status.lastEventAt = receivedAt;
    if (context.pendingFailure) return;
    if (code === "listener-failed") {
      this.failGeneration(context, "helper-listener-failed");
      return;
    }

    this.status.lastError = `helper-${code}`;
    if (code === "too-large") this.status.filteredCount += 1;
    this.emitStatus();
    this.requestReconcile(context);
  }

  private requestReconcile(context: GenerationContext): void {
    if (!this.canProcessFrames(context)) return;
    let result: Promise<void> | void;
    try {
      result = this.onReconcile();
    } catch {
      this.recordReconcileFailure(context);
      return;
    }
    void Promise.resolve(result).catch(() => {
      this.recordReconcileFailure(context);
    });
  }

  private recordReconcileFailure(context: GenerationContext): void {
    if (!this.canProcessFrames(context) || context.pendingFailure) return;
    this.status.lastError = "reconcile-failed";
    this.emitStatus();
  }

  private recordFixedError(context: GenerationContext, error: string): void {
    if (!this.canProcessFrames(context) || context.pendingFailure) return;
    this.status.lastError = error;
    this.emitStatus();
  }

  private failGeneration(
    context: GenerationContext,
    error: string,
    exit?: { code: number | null; signal: string | null }
  ): void {
    if (
      !this.isCurrent(context) ||
      context.failed ||
      context.pendingFailure ||
      this.phase === "stopping"
    ) {
      return;
    }

    context.failed = true;
    context.pendingFailure = null;
    this.clearFailureDrainTimer(context);
    this.clearGenerationTimers(context);
    this.resumeStdout(context);
    this.status.helperPid = null;
    this.status.lastError = error;
    if (exit) this.status.lastExit = { ...exit };

    if (!this.desiredRunning) {
      this.phase = "stopped";
      this.status.mode = this.modeForPhase(this.phase);
      this.status.nextRestartAt = null;
      this.emitStatus();
      this.killChild(context);
      return;
    }

    this.status.restartCount += 1;
    const base = BACKOFF_MS[Math.min(this.backoffAttempt, BACKOFF_MS.length - 1)];
    this.backoffAttempt += 1;
    const random = Math.max(0, Math.min(1, this.random()));
    const delay = Math.round(base * (0.8 + (0.4 * random)));
    this.phase = "backoff";
    this.status.mode = this.modeForPhase(this.phase);
    this.status.nextRestartAt = this.now() + delay;
    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.desiredRunning || this.phase !== "backoff") return;
      this.spawnGeneration();
    }, delay);
    this.emitStatus();
    this.killChild(context);
  }

  private requestGenerationFailure(
    context: GenerationContext,
    error: string,
    exit?: { code: number | null; signal: string | null }
  ): void {
    if (
      !this.isCurrent(context) ||
      this.phase === "stopping"
    ) {
      return;
    }
    if (context.failed) {
      if (exit) {
        this.status.lastExit = { ...exit };
        this.emitStatus();
      }
      return;
    }
    if (context.pendingFailure) {
      if (exit && !context.pendingFailure.exit) {
        context.pendingFailure.exit = { ...exit };
        this.status.lastExit = { ...exit };
        this.emitStatus();
      }
      return;
    }
    if (context.pendingFrameCount === 0) {
      this.failGeneration(context, error, exit);
      return;
    }

    context.pendingFailure = { error, ...(exit ? { exit: { ...exit } } : {}) };
    this.clearGenerationTimers(context);
    this.status.mode = "fallback";
    this.status.helperPid = null;
    this.status.nextRestartAt = null;
    this.status.lastError = error;
    if (exit) this.status.lastExit = { ...exit };
    this.emitStatus();
    if (!this.canScheduleFailureDrain(context)) return;
    context.failureDrainTimer = setTimeout(() => {
      this.finishPendingFailure(context);
    }, FAILURE_DRAIN_TIMEOUT_MS);
  }

  private canScheduleFailureDrain(context: GenerationContext): boolean {
    return (
      this.isCurrent(context) &&
      !context.failed &&
      context.pendingFailure !== null &&
      this.phase !== "stopping"
    );
  }

  private finishPendingFailure(context: GenerationContext): void {
    const failure = context.pendingFailure;
    if (!failure) return;

    context.pendingFailure = null;
    this.clearFailureDrainTimer(context);
    this.failGeneration(context, failure.error, failure.exit);
  }

  private armReadyTimer(context: GenerationContext): void {
    this.clearTimer(context, "readyTimer");
    if (
      !this.isCurrent(context) ||
      context.failed ||
      context.pendingFailure ||
      context.stdoutPaused ||
      this.phase !== "starting"
    ) {
      return;
    }
    context.readyTimer = setTimeout(() => {
      this.failGeneration(context, "ready-timeout");
    }, this.readyTimeoutMs);
  }

  private armHeartbeatTimer(context: GenerationContext, receivedAt: number): void {
    this.clearTimer(context, "heartbeatTimer");
    if (
      !this.isCurrent(context) ||
      context.failed ||
      context.pendingFailure ||
      context.stdoutPaused ||
      this.phase !== "running"
    ) {
      return;
    }
    const delay = Math.max(0, (receivedAt + this.heartbeatTimeoutMs) - this.now());
    context.heartbeatTimer = setTimeout(() => {
      this.failGeneration(context, "heartbeat-timeout");
    }, delay);
  }

  private armHealthyTimer(context: GenerationContext, receivedAt: number): void {
    this.clearTimer(context, "healthyTimer");
    const delay = Math.max(0, (receivedAt + HEALTHY_RESET_MS) - this.now());
    context.healthyTimer = setTimeout(() => {
      if (!this.isCurrent(context) || context.failed || this.phase !== "running") return;
      this.backoffAttempt = 0;
    }, delay);
  }

  private clearGenerationTimers(context: GenerationContext): void {
    this.clearTimer(context, "readyTimer");
    this.clearTimer(context, "heartbeatTimer");
    this.clearTimer(context, "healthyTimer");
  }

  private clearTimer(
    context: GenerationContext,
    key: "readyTimer" | "heartbeatTimer" | "healthyTimer"
  ): void {
    const timer = context[key];
    if (timer) clearTimeout(timer);
    context[key] = null;
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private clearFailureDrainTimer(context: GenerationContext): void {
    if (context.failureDrainTimer) clearTimeout(context.failureDrainTimer);
    context.failureDrainTimer = null;
  }

  private resumeStdout(context: GenerationContext): void {
    if (!context.stdoutPaused) return;
    context.stdoutPaused = false;
    try {
      context.child?.stdout?.resume();
    } catch {
      // The generation is already failing or stopping.
    }
  }

  private writeCommand(context: GenerationContext, command: string): void {
    if (!this.isCurrent(context) || !context.child?.stdin) return;
    try {
      context.child.stdin.write(command);
    } catch {
      // Pipe closure is handled by the child lifecycle events or stop timeout.
    }
  }

  private killChild(context: GenerationContext): void {
    if (!context.child) return;
    try {
      context.child.kill();
    } catch {
      // The process may already have exited.
    }
  }

  private settleStopped(context: GenerationContext | null): void {
    if (this.phase !== "stopping") return;
    if (context && !this.isCurrent(context)) return;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    if (context) {
      context.failed = true;
      context.pendingFailure = null;
      this.clearFailureDrainTimer(context);
      this.clearGenerationTimers(context);
    }
    this.active = null;
    this.phase = "stopped";
    this.status.mode = this.modeForPhase(this.phase);
    this.status.helperPid = null;
    this.status.nextRestartAt = null;
    this.finishStopPromise();
    this.emitStatus();
  }

  private finishStopPromise(): void {
    const resolve = this.resolveStop;
    this.resolveStop = null;
    resolve?.();
  }

  private canProcessFrames(context: GenerationContext): boolean {
    return (
      this.isCurrent(context) &&
      !context.failed &&
      (this.phase === "starting" || this.phase === "running")
    );
  }

  private isCurrent(context: GenerationContext): boolean {
    return this.active === context && this.status.helperGeneration === context.generation;
  }

  private modeForPhase(phase: Phase): ClipboardBackgroundMode {
    switch (phase) {
      case "starting":
        return "starting";
      case "running":
        return "listening";
      case "backoff":
        return "fallback";
      case "stopping":
      case "stopped":
        return "stopped";
    }
  }

  private copyStatus(): ClipboardBackgroundState {
    return {
      ...this.status,
      lastExit: this.status.lastExit ? { ...this.status.lastExit } : null
    };
  }

  private emitStatus(): void {
    let result: unknown;
    try {
      result = (this.onStatusChange as (status: ClipboardBackgroundState) => unknown)(
        this.copyStatus()
      );
    } catch {
      return;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
    }
  }
}
