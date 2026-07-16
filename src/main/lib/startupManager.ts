import type { App } from "electron";
import {
  STARTUP_DECISION_VERSION,
  type AppSettings,
  type StartupState
} from "../../shared/types";

export const LOGIN_ITEM_ARG = "--launch-at-login";

export type LoginItemApp = Pick<
  App,
  "isPackaged" | "setLoginItemSettings" | "getLoginItemSettings"
>;

export type StartupSettingsStore = {
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
};

export function isLaunchAtLogin(argv: readonly string[]): boolean {
  return argv.includes(LOGIN_ITEM_ARG);
}

export function shouldShowForSecondInstance(argv: readonly string[]): boolean {
  return !isLaunchAtLogin(argv);
}

export class SecondInstanceWindowCoordinator {
  private pendingShow = false;

  handleSecondInstance(
    commandLine: readonly string[],
    windowExists: boolean,
    showAndFocus: () => void
  ): void {
    if (!shouldShowForSecondInstance(commandLine)) {
      return;
    }

    if (windowExists) {
      showAndFocus();
    } else {
      this.pendingShow = true;
    }
  }

  consumePendingShow(showAndFocus: () => void): void {
    if (!this.pendingShow) {
      return;
    }

    this.pendingShow = false;
    showAndFocus();
  }
}

export class StartupManager {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: LoginItemApp,
    private readonly settingsStore: StartupSettingsStore,
    private readonly executablePath: string = process.execPath
  ) {}

  async getState(): Promise<StartupState> {
    const settings = await this.settingsStore.getSettings();
    return this.readState(settings);
  }

  setEnabled(enabled: boolean): Promise<StartupState> {
    return this.enqueue(async () => {
      const settings = await this.settingsStore.updateSettings({
        launchAtStartup: enabled,
        startupDecisionVersion: STARTUP_DECISION_VERSION
      });
      return this.applyAndReadState(settings);
    });
  }

  reconcile(): Promise<StartupState> {
    return this.enqueue(async () => {
      const settings = await this.settingsStore.getSettings();
      return this.applyAndReadState(settings);
    });
  }

  private applyAndReadState(settings: AppSettings): StartupState {
    if (!this.app.isPackaged) {
      return this.createState(settings, null, false, null);
    }

    try {
      this.applyDesiredState(settings.launchAtStartup);
    } catch {
      return this.createState(settings, null, true, "apply-failed");
    }

    return this.readState(settings);
  }

  private applyDesiredState(enabled: boolean): void {
    this.app.setLoginItemSettings({
      openAtLogin: false,
      path: this.executablePath,
      args: []
    });
    this.app.setLoginItemSettings({
      openAtLogin: enabled,
      path: this.executablePath,
      args: [LOGIN_ITEM_ARG]
    });
  }

  private readState(settings: AppSettings): StartupState {
    if (!this.app.isPackaged) {
      return this.createState(settings, null, false, null);
    }

    let actualEnabled: boolean;
    try {
      const systemSettings = this.app.getLoginItemSettings({
        path: this.executablePath,
        args: [LOGIN_ITEM_ARG]
      });
      actualEnabled = systemSettings.openAtLogin;
    } catch {
      return this.createState(settings, null, true, "query-failed");
    }

    return this.createState(
      settings,
      actualEnabled,
      true,
      settings.launchAtStartup === actualEnabled ? null : "state-mismatch"
    );
  }

  private createState(
    settings: AppSettings,
    actualEnabled: boolean | null,
    managed: boolean,
    error: StartupState["error"]
  ): StartupState {
    return {
      desiredEnabled: settings.launchAtStartup,
      actualEnabled,
      pendingDecision: settings.startupDecisionVersion < STARTUP_DECISION_VERSION,
      managed,
      error
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
