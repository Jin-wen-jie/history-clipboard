import type { AppSettings, ClipboardBackgroundState } from "../../shared/types";
import {
  ClipboardAgentSupervisor,
  type ClipboardAgentSupervisorOptions
} from "./clipboardAgentSupervisor";
import type { NativeClipboardSnapshot } from "./clipboardAgentProtocol";
import {
  ClipboardWatcher,
  type CaptureQueueState,
  type ClipboardSnapshot,
  type ClipboardWatcherOptions
} from "./clipboardWatcher";
import type { ImageInput } from "./historyStore";

type RuntimeWatcherOptions = Omit<
  ClipboardWatcherOptions,
  "onBackpressureChange" | "onQueueStateChange" | "onFiltered"
>;

export type ClipboardRuntimeOptions = {
  helperPath: string;
  watcherOptions: RuntimeWatcherOptions;
  createImageInput: (png: Buffer, width: number, height: number) => ImageInput;
  onStatusChange?: (state: ClipboardBackgroundState) => void;
  createWatcher?: (options: ClipboardWatcherOptions) => ClipboardWatcher;
  createSupervisor?: (
    options: ClipboardAgentSupervisorOptions
  ) => ClipboardAgentSupervisor;
};

export function shouldReconcileAfterSettingsChange(
  before: AppSettings,
  after: AppSettings
): boolean {
  return (
    (!before.captureEnabled && after.captureEnabled) ||
    (before.sensitiveFilterEnabled && !after.sensitiveFilterEnabled) ||
    before.maxTextLength !== after.maxTextLength ||
    before.maxImageBytes !== after.maxImageBytes
  );
}

const INITIAL_STATE: ClipboardBackgroundState = {
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

export class ClipboardRuntime {
  private readonly watcher: ClipboardWatcher;
  private readonly supervisor: ClipboardAgentSupervisor;
  private supervisorState: ClipboardBackgroundState = { ...INITIAL_STATE };
  private queueState: CaptureQueueState = { depth: 0, bytes: 0, backpressured: false };
  private watcherFilteredCount = 0;
  private started = false;
  private stopping = false;
  private watcherStopped = false;
  private lastReadyGeneration: number | null = null;
  private backpressured = false;
  private suppressNextReconcile = false;
  private supervisorStopPromise: Promise<void> | null = null;
  private producerStopPromise: Promise<void> | null = null;

  constructor(private readonly options: ClipboardRuntimeOptions) {
    const createWatcher = options.createWatcher ?? ((watcherOptions) => (
      new ClipboardWatcher(watcherOptions)
    ));
    this.watcher = createWatcher({
      ...options.watcherOptions,
      onBackpressureChange: (paused) => this.handleBackpressureChange(paused),
      onQueueStateChange: (state) => this.handleQueueStateChange(state),
      onFiltered: () => this.handleFiltered()
    });

    const createSupervisor = options.createSupervisor ?? ((supervisorOptions) => (
      new ClipboardAgentSupervisor(supervisorOptions)
    ));
    this.supervisor = createSupervisor({
      helperPath: options.helperPath,
      onSnapshot: (snapshot) => this.captureNative(snapshot),
      onReconcile: () => this.handleSupervisorReconcile(),
      onStatusChange: (status) => this.handleSupervisorStatus(status)
    });
    this.supervisorState = this.copyState(this.supervisor.getStatus());
    this.queueState = { ...this.watcher.getQueueState() };
  }

  start(): void {
    if (this.started || this.stopping) {
      return;
    }
    this.started = true;
    this.watcher.startFallbackPolling();
    this.supervisor.start();
  }

  stopProducers(): Promise<void> {
    if (this.producerStopPromise) {
      return this.producerStopPromise;
    }
    this.producerStopPromise = (async () => {
      try {
        await this.stopSupervisor();
      } finally {
        this.stopWatcher();
      }
    })();
    return this.producerStopPromise;
  }

  stopSupervisor(): Promise<void> {
    this.stopping = true;
    if (!this.supervisorStopPromise) {
      this.supervisorStopPromise = this.supervisor.stop();
    }
    return this.supervisorStopPromise;
  }

  stopWatcher(): void {
    this.stopping = true;
    if (this.watcherStopped) {
      return;
    }
    this.watcherStopped = true;
    this.watcher.stop();
    this.supervisorState = {
      ...this.supervisorState,
      mode: "stopped",
      helperPid: null,
      nextRestartAt: null
    };
    this.emitState();
  }

  drain(): Promise<void> {
    return this.watcher.drain();
  }

  handleSystemResume(): void {
    if (this.stopping) {
      return;
    }
    if (this.supervisorState.mode === "listening") {
      this.suppressImmediateReconcile();
    }
    try {
      this.supervisor.handleSystemResume();
    } catch {
      console.error("Clipboard system resume handling failed");
    }
    this.scheduleForceReconcile();
  }

  reconcileAfterSettingsChange(): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }
    return this.watcher.reconcileOnce({ force: true });
  }

  getState(): ClipboardBackgroundState {
    return this.copyState(this.mergedState());
  }

  private async captureNative(snapshot: NativeClipboardSnapshot): Promise<void> {
    const capture: ClipboardSnapshot = { text: snapshot.text ?? "" };
    if (
      snapshot.png &&
      snapshot.width !== undefined &&
      snapshot.height !== undefined
    ) {
      const png = Buffer.from(snapshot.png);
      capture.image = this.options.createImageInput(png, snapshot.width, snapshot.height);
    }
    await this.watcher.captureNative(capture);
  }

  private handleSupervisorStatus(status: ClipboardBackgroundState): void {
    if (this.stopping) {
      return;
    }
    this.supervisorState = this.copyState(status);
    if (this.started && status.mode === "listening") {
      this.watcher.stopFallbackPolling();
      if (this.lastReadyGeneration !== status.helperGeneration) {
        this.lastReadyGeneration = status.helperGeneration;
        this.suppressImmediateReconcile();
        this.scheduleForceReconcile();
      }
    } else if (
      this.started &&
      (status.mode === "starting" || status.mode === "fallback")
    ) {
      this.watcher.startFallbackPolling();
    }
    this.emitState();
  }

  private handleBackpressureChange(paused: boolean): void {
    if (this.stopping) {
      return;
    }
    const resumed = this.backpressured && !paused;
    this.backpressured = paused;
    this.supervisor.setOutputPaused(paused);
    if (resumed) {
      this.scheduleForceReconcile();
    }
  }

  private handleSupervisorReconcile(): Promise<void> {
    if (this.suppressNextReconcile) {
      this.suppressNextReconcile = false;
      return Promise.resolve();
    }
    return this.watcher.reconcileOnce();
  }

  private suppressImmediateReconcile(): void {
    this.suppressNextReconcile = true;
    queueMicrotask(() => {
      this.suppressNextReconcile = false;
    });
  }

  private handleQueueStateChange(state: CaptureQueueState): void {
    if (this.stopping) {
      return;
    }
    this.queueState = { ...state };
    this.emitState();
  }

  private handleFiltered(): void {
    if (this.stopping) {
      return;
    }
    this.watcherFilteredCount += 1;
    this.emitState();
  }

  private scheduleForceReconcile(): void {
    void this.watcher.reconcileOnce({ force: true }).catch(() => {
      console.error("Clipboard force reconcile failed");
    });
  }

  private mergedState(): ClipboardBackgroundState {
    return {
      ...this.supervisorState,
      filteredCount: this.supervisorState.filteredCount + this.watcherFilteredCount,
      queueDepth: this.queueState.depth,
      queueBytes: this.queueState.bytes,
      lastExit: this.supervisorState.lastExit
        ? { ...this.supervisorState.lastExit }
        : null
    };
  }

  private emitState(): void {
    try {
      this.options.onStatusChange?.(this.getState());
    } catch {
      console.error("Clipboard runtime status callback failed");
    }
  }

  private copyState(state: ClipboardBackgroundState): ClipboardBackgroundState {
    return {
      ...state,
      lastExit: state.lastExit ? { ...state.lastExit } : null
    };
  }
}
