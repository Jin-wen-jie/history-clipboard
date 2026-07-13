export type ShutdownDependencies = {
  stopSupervisor(): Promise<void>;
  stopWatcher(): void;
  drainWatcher(): Promise<void>;
  flushStore(): Promise<void>;
  unregisterShortcuts(): void;
  quit(): void;
  onError(error: unknown): void;
};

export class ShutdownCoordinator {
  private shutdownPromise: Promise<void> | null = null;
  private shutdownStarted = false;
  private shutdownComplete = false;

  constructor(private readonly deps: ShutdownDependencies) {}

  get isQuitting(): boolean {
    return this.shutdownStarted;
  }

  handleBeforeQuit(event: { preventDefault(): void }): void {
    if (this.shutdownComplete) {
      return;
    }
    event.preventDefault();
    if (this.shutdownStarted) {
      return;
    }
    this.shutdownStarted = true;
    this.shutdownPromise = this.shutdown();
  }

  private async shutdown(): Promise<void> {
    await this.attempt(() => this.deps.stopSupervisor());
    await this.attempt(() => this.deps.stopWatcher());
    await this.attempt(() => this.deps.drainWatcher());
    await this.attempt(() => this.deps.flushStore());
    await this.attempt(() => this.deps.unregisterShortcuts());
    this.shutdownComplete = true;
    await this.attempt(() => this.deps.quit());
  }

  private async attempt(step: () => Promise<void> | void): Promise<void> {
    try {
      await step();
    } catch (error) {
      try {
        this.deps.onError(error);
      } catch {
        // Error reporting must not interrupt the remaining shutdown steps.
      }
    }
  }
}
