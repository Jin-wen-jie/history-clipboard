import type { App } from "electron";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "../../shared/types";
import {
  LOGIN_ITEM_ARG,
  SecondInstanceWindowCoordinator,
  StartupManager,
  isLaunchAtLogin,
  shouldShowForSecondInstance
} from "./startupManager";

type LoginApp = Pick<
  App,
  "isPackaged" | "setLoginItemSettings" | "getLoginItemSettings"
>;
type LoginItemSettings = ReturnType<App["getLoginItemSettings"]>;
type LoginItem = LoginItemSettings["launchItems"][number];
type LoginItemOptions = Parameters<App["setLoginItemSettings"]>[0];
type LoginItemQuery = Parameters<App["getLoginItemSettings"]>[0];

const executablePath = "C:\\Program Files\\History Clipboard\\History Clipboard.exe";

function createSettingsHarness(
  patch: Partial<AppSettings> = {}
): {
  getSettings: ReturnType<typeof vi.fn<() => Promise<AppSettings>>>;
  updateSettings: ReturnType<typeof vi.fn<(patch: Partial<AppSettings>) => Promise<AppSettings>>>;
  persist: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  current: () => AppSettings;
} {
  let settings: AppSettings = { ...DEFAULT_SETTINGS, ...patch };
  const persist = async (nextPatch: Partial<AppSettings>): Promise<AppSettings> => {
    settings = { ...settings, ...nextPatch };
    return { ...settings };
  };

  return {
    getSettings: vi.fn(async () => ({ ...settings })),
    updateSettings: vi.fn(persist),
    persist,
    current: () => ({ ...settings })
  };
}

function loginItem(
  path: string,
  args: string[],
  enabled = true
): LoginItem {
  return {
    name: "HistoryClipboard",
    path,
    args,
    scope: "user",
    enabled
  };
}

function loginSettings(
  launchItems: LoginItem[],
  patch: Partial<LoginItemSettings> = {}
): LoginItemSettings {
  return {
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAtLogin: false,
    wasOpenedAsHidden: false,
    restoreState: false,
    status: "not-registered",
    executableWillLaunchAtLogin: false,
    launchItems,
    ...patch
  };
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((arg, index) => arg === right[index]);
}

function createAppHarness(options: {
  isPackaged?: boolean;
  launchItems?: LoginItem[];
  queryResult?: LoginItemSettings;
  queryError?: Error;
  applyError?: Error;
} = {}): {
  app: LoginApp;
  setLoginItemSettings: ReturnType<typeof vi.fn<(options: LoginItemOptions) => void>>;
  getLoginItemSettings: ReturnType<typeof vi.fn<(options?: LoginItemQuery) => LoginItemSettings>>;
} {
  let launchItems = [...(options.launchItems ?? [])];
  const setLoginItemSettings = vi.fn((settings: LoginItemOptions): void => {
    if (options.applyError) {
      throw options.applyError;
    }

    const path = settings.path ?? executablePath;
    const args = settings.args ?? [];
    launchItems = launchItems.filter(
      (item) => item.path !== path || !sameArgs(item.args, args)
    );
    if (settings.openAtLogin) {
      launchItems.push(loginItem(path, [...args], settings.enabled ?? true));
    }
  });
  const getLoginItemSettings = vi.fn((_query?: LoginItemQuery): LoginItemSettings => {
    if (options.queryError) {
      throw options.queryError;
    }
    return options.queryResult ?? loginSettings([...launchItems]);
  });

  return {
    app: {
      isPackaged: options.isPackaged ?? true,
      setLoginItemSettings,
      getLoginItemSettings
    } as LoginApp,
    setLoginItemSettings,
    getLoginItemSettings
  };
}

describe("startup launch source", () => {
  test("recognizes only the exact standalone login argument", () => {
    expect(LOGIN_ITEM_ARG).toBe("--launch-at-login");
    expect(isLaunchAtLogin(["History Clipboard.exe", LOGIN_ITEM_ARG])).toBe(true);
    expect(isLaunchAtLogin([LOGIN_ITEM_ARG])).toBe(true);
    expect(isLaunchAtLogin(["--launch-at-login=true"])).toBe(false);
    expect(isLaunchAtLogin(["prefix--launch-at-login"])).toBe(false);
    expect(isLaunchAtLogin(["History Clipboard.exe"])).toBe(false);
  });

  test("shows second instances unless they carry the exact login argument", () => {
    expect(shouldShowForSecondInstance(["History Clipboard.exe"])).toBe(true);
    expect(shouldShowForSecondInstance(["History Clipboard.exe", LOGIN_ITEM_ARG])).toBe(false);
    expect(shouldShowForSecondInstance(["--launch-at-login=true"])).toBe(true);
  });
});

describe("SecondInstanceWindowCoordinator", () => {
  test("preserves a normal second-instance show request until the window exists", () => {
    const coordinator = new SecondInstanceWindowCoordinator();
    const showAndFocus = vi.fn();

    coordinator.handleSecondInstance(["History Clipboard.exe"], false, showAndFocus);
    expect(showAndFocus).not.toHaveBeenCalled();

    coordinator.consumePendingShow(showAndFocus);
    expect(showAndFocus).toHaveBeenCalledTimes(1);

    coordinator.consumePendingShow(showAndFocus);
    expect(showAndFocus).toHaveBeenCalledTimes(1);
  });

  test("ignores login launches and immediately handles ordinary instances when ready", () => {
    const coordinator = new SecondInstanceWindowCoordinator();
    const showAndFocus = vi.fn();

    coordinator.handleSecondInstance(
      ["History Clipboard.exe", LOGIN_ITEM_ARG],
      false,
      showAndFocus
    );
    coordinator.consumePendingShow(showAndFocus);
    expect(showAndFocus).not.toHaveBeenCalled();

    coordinator.handleSecondInstance(["History Clipboard.exe"], true, showAndFocus);
    expect(showAndFocus).toHaveBeenCalledTimes(1);
  });
});

describe("StartupManager", () => {
  test("uses process.execPath as the managed executable by default", async () => {
    const settings = createSettingsHarness({ launchAtStartup: false });
    const app = createAppHarness();
    const manager = new StartupManager(app.app, settings);

    await manager.setEnabled(true);

    expect(app.setLoginItemSettings.mock.calls.map(([call]) => call)).toEqual([
      { openAtLogin: false, path: process.execPath, args: [] },
      { openAtLogin: true, path: process.execPath, args: [LOGIN_ITEM_ARG] }
    ]);
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({
      path: process.execPath,
      args: [LOGIN_ITEM_ARG]
    });
  });

  test.each([
    ["an exact enabled item", [loginItem(executablePath, [LOGIN_ITEM_ARG])], true, null],
    ["a different path", [loginItem(`${executablePath}.old`, [LOGIN_ITEM_ARG])], false, "state-mismatch"],
    ["extra arguments", [loginItem(executablePath, [LOGIN_ITEM_ARG, "--extra"])], false, "state-mismatch"],
    ["arguments in a different position", [loginItem(executablePath, ["--extra", LOGIN_ITEM_ARG])], false, "state-mismatch"],
    ["a disabled item", [loginItem(executablePath, [LOGIN_ITEM_ARG], false)], false, "state-mismatch"]
  ] as const)(
    "strictly evaluates %s from launchItems",
    async (_name, items, actualEnabled, error) => {
      const settings = createSettingsHarness({ launchAtStartup: true });
      const app = createAppHarness({
        queryResult: loginSettings([...items], {
          openAtLogin: true,
          executableWillLaunchAtLogin: true
        })
      });
      const manager = new StartupManager(app.app, settings, executablePath);

      await expect(manager.getState()).resolves.toEqual({
        desiredEnabled: true,
        actualEnabled,
        pendingDecision: false,
        managed: true,
        error
      });
      expect(app.getLoginItemSettings).toHaveBeenCalledWith({
        path: executablePath,
        args: [LOGIN_ITEM_ARG]
      });
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
      expect(settings.updateSettings).not.toHaveBeenCalled();
    }
  );

  test("enables by removing the legacy no-argument item before registering the managed item", async () => {
    const settings = createSettingsHarness({ launchAtStartup: false });
    const app = createAppHarness({
      launchItems: [loginItem(executablePath, [])]
    });
    const manager = new StartupManager(app.app, settings, executablePath);

    await expect(manager.setEnabled(true)).resolves.toEqual({
      desiredEnabled: true,
      actualEnabled: true,
      pendingDecision: false,
      managed: true,
      error: null
    });

    expect(settings.updateSettings).toHaveBeenCalledWith({
      launchAtStartup: true,
      startupDecisionVersion: 1
    });
    expect(app.setLoginItemSettings.mock.calls.map(([call]) => call)).toEqual([
      { openAtLogin: false, path: executablePath, args: [] },
      { openAtLogin: true, path: executablePath, args: [LOGIN_ITEM_ARG] }
    ]);
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({
      path: executablePath,
      args: [LOGIN_ITEM_ARG]
    });
  });

  test("disables both the legacy and managed login items in order", async () => {
    const settings = createSettingsHarness({ launchAtStartup: true });
    const app = createAppHarness({
      launchItems: [
        loginItem(executablePath, []),
        loginItem(executablePath, [LOGIN_ITEM_ARG])
      ]
    });
    const manager = new StartupManager(app.app, settings, executablePath);

    await expect(manager.setEnabled(false)).resolves.toMatchObject({
      desiredEnabled: false,
      actualEnabled: false,
      error: null
    });
    expect(app.setLoginItemSettings.mock.calls.map(([call]) => call)).toEqual([
      { openAtLogin: false, path: executablePath, args: [] },
      { openAtLogin: false, path: executablePath, args: [LOGIN_ITEM_ARG] }
    ]);
  });

  test("persists choices but never calls login APIs in development", async () => {
    const settings = createSettingsHarness({
      launchAtStartup: false,
      startupDecisionVersion: 0
    });
    const app = createAppHarness({ isPackaged: false });
    const manager = new StartupManager(app.app, settings, executablePath);

    await expect(manager.setEnabled(true)).resolves.toEqual({
      desiredEnabled: true,
      actualEnabled: null,
      pendingDecision: false,
      managed: false,
      error: null
    });
    await expect(manager.reconcile()).resolves.toMatchObject({
      desiredEnabled: true,
      actualEnabled: null,
      managed: false
    });
    expect(settings.updateSettings).toHaveBeenCalledWith({
      launchAtStartup: true,
      startupDecisionVersion: 1
    });
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
  });

  test("reports query failures without changing settings", async () => {
    const settings = createSettingsHarness({ launchAtStartup: true });
    const app = createAppHarness({ queryError: new Error("registry unavailable") });
    const manager = new StartupManager(app.app, settings, executablePath);

    await expect(manager.getState()).resolves.toEqual({
      desiredEnabled: true,
      actualEnabled: null,
      pendingDecision: false,
      managed: true,
      error: "query-failed"
    });
    expect(settings.updateSettings).not.toHaveBeenCalled();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  test("keeps the persisted desired state when applying it fails", async () => {
    const settings = createSettingsHarness({ launchAtStartup: false });
    const app = createAppHarness({ applyError: new Error("registry denied") });
    const manager = new StartupManager(app.app, settings, executablePath);

    await expect(manager.setEnabled(true)).resolves.toEqual({
      desiredEnabled: true,
      actualEnabled: null,
      pendingDecision: false,
      managed: true,
      error: "apply-failed"
    });
    expect(settings.current()).toMatchObject({
      launchAtStartup: true,
      startupDecisionVersion: 1
    });
    expect(settings.updateSettings).toHaveBeenCalledTimes(1);
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1);
  });

  test("rejects persistence failures without touching the system", async () => {
    const settings = createSettingsHarness({ launchAtStartup: false });
    settings.updateSettings.mockRejectedValueOnce(new Error("disk full"));
    const app = createAppHarness();
    const manager = new StartupManager(app.app, settings, executablePath);

    await expect(manager.setEnabled(true)).rejects.toThrow("disk full");
    expect(settings.current().launchAtStartup).toBe(false);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
  });

  test("reconciles a pending legacy preference without changing its decision version", async () => {
    const settings = createSettingsHarness({
      launchAtStartup: true,
      startupDecisionVersion: 0
    });
    const app = createAppHarness({
      launchItems: [loginItem(executablePath, [])]
    });
    const manager = new StartupManager(app.app, settings, executablePath);

    await expect(manager.reconcile()).resolves.toEqual({
      desiredEnabled: true,
      actualEnabled: true,
      pendingDecision: true,
      managed: true,
      error: null
    });
    expect(settings.updateSettings).not.toHaveBeenCalled();
    expect(settings.current().startupDecisionVersion).toBe(0);
    expect(app.setLoginItemSettings.mock.calls.map(([call]) => call)).toEqual([
      { openAtLogin: false, path: executablePath, args: [] },
      { openAtLogin: true, path: executablePath, args: [LOGIN_ITEM_ARG] }
    ]);
  });

  test("serializes rapid choices so the last persisted choice wins", async () => {
    const settings = createSettingsHarness({ launchAtStartup: false });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    settings.updateSettings.mockImplementationOnce(async (patch) => {
      await firstGate;
      return settings.persist(patch);
    });
    const app = createAppHarness();
    const manager = new StartupManager(app.app, settings, executablePath);

    const first = manager.setEnabled(true);
    const second = manager.setEnabled(false);

    await vi.waitFor(() => expect(settings.updateSettings).toHaveBeenCalledTimes(1));
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    releaseFirst();
    await Promise.all([first, second]);

    expect(settings.updateSettings.mock.calls.map(([patch]) => patch.launchAtStartup)).toEqual([
      true,
      false
    ]);
    expect(settings.current().launchAtStartup).toBe(false);
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(4);
  });

  test("continues the serial chain after a persistence failure", async () => {
    const settings = createSettingsHarness({ launchAtStartup: true });
    settings.updateSettings.mockRejectedValueOnce(new Error("first write failed"));
    const app = createAppHarness({
      launchItems: [loginItem(executablePath, [LOGIN_ITEM_ARG])]
    });
    const manager = new StartupManager(app.app, settings, executablePath);

    const first = manager.setEnabled(false);
    const firstResult = expect(first).rejects.toThrow("first write failed");
    const second = manager.setEnabled(true);

    await firstResult;
    await expect(second).resolves.toMatchObject({
      desiredEnabled: true,
      actualEnabled: true,
      error: null
    });
    expect(settings.updateSettings).toHaveBeenCalledTimes(2);
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(2);
  });
});
