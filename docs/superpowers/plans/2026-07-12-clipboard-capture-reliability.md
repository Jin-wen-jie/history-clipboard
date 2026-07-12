# Clipboard Capture Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows 上每次可观察到的剪贴板变更都立即形成快照、串行加密落盘，并消除静默过滤和退出时元数据未写完造成的记录遗漏。

**Architecture:** 用一个独立 Windows 消息助手接收 `WM_CLIPBOARDUPDATE`，主进程按剪贴板序列号去重事件。`ClipboardWatcher` 在事件回调中同步读取文本和图片快照，再把快照送入单消费者 Promise 队列；低频轮询只作为助手失败时的兜底。`HistoryStore` 的元数据写入改为串行、可等待、带临时文件和备份恢复，应用退出前排空采集与存储队列。

**Tech Stack:** Electron 42、TypeScript 5.7、Vitest、C#/.NET Framework WinForms、electron-vite、electron-builder

---

### Task 1: 建立干净基线

**Files:**
- Verify: `package.json`
- Verify: `package-lock.json`

- [ ] **Step 1: 安装锁定依赖**

Run: `npm ci`

Expected: exit 0，`package-lock.json` 不发生变化。

- [ ] **Step 2: 运行原始测试**

Run: `npm test`

Expected: 所有原始测试通过，0 failures。

- [ ] **Step 3: 运行原始构建**

Run: `npm run build`

Expected: TypeScript 与 electron-vite 均 exit 0。

### Task 2: Windows 变更事件与无丢失快照队列

**Files:**
- Create: `native/clipboard-listener/Program.cs`
- Create: `scripts/buildClipboardListener.cjs`
- Create: `src/main/lib/clipboardChangeMonitor.ts`
- Create: `src/main/lib/clipboardChangeMonitor.test.ts`
- Modify: `src/main/lib/clipboardWatcher.ts`
- Modify: `src/main/lib/clipboardWatcher.test.ts`
- Modify: `src/main/index.ts`
- Modify: `package.json`

- [ ] **Step 1: 写事件行解析的失败测试**

在 `clipboardChangeMonitor.test.ts` 中覆盖：同一 stdout chunk 内含 `READY 10\r\nCHANGE 11\r\nCHANGE 12\r\n` 时必须依次产生 11、12；重复 sequence 必须只通知一次；残缺行必须保留到下一 chunk。

```ts
expect(sequences).toEqual([11, 12]);
expect(parser.push("CHANGE 2")).toEqual([]);
expect(parser.push("1\r\n")).toEqual([21]);
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/main/lib/clipboardChangeMonitor.test.ts`

Expected: FAIL，因为 `clipboardChangeMonitor.ts` 尚不存在。

- [ ] **Step 3: 实现最小事件解析器与进程监控器**

公开接口固定为：

```ts
export class ClipboardEventLineParser {
  push(chunk: Buffer | string): number[];
}

export class ClipboardChangeMonitor {
  constructor(options: {
    helperPath: string;
    onChange: (sequence: number) => void;
    spawn?: typeof spawn;
  });
  start(): void;
  stop(): void;
}
```

监控器用 `windowsHide: true` 启动助手，逐行解析 stdout，助手异常退出时记录错误但不终止应用。

- [ ] **Step 4: 写快速连续变更的失败测试**

在 `clipboardWatcher.test.ts` 新增：第一次 `addText("A")` 被 deferred Promise 阻塞时，立刻把 fake clipboard 改为 B 并触发第二个变更；断言 A、B 都被处理且最大 in-flight 为 1。

```ts
const first = watcher.captureChange();
clipboardText = "B";
const second = watcher.captureChange();
expect(readSnapshots).toEqual(["A", "B"]);
expect(maxInFlight).toBe(1);
await Promise.all([first, second]);
```

- [ ] **Step 5: 运行测试确认 RED**

Run: `npx vitest run src/main/lib/clipboardWatcher.test.ts`

Expected: FAIL，因为当前 `isCapturing` 会直接跳过第二次调用，且没有 `captureChange()`。

- [ ] **Step 6: 实现同步快照与串行队列**

`captureChange()` 必须在任何 `await` 前读取图片和文本；Promise tail 只串行执行 `addImage`/`addText`。事件触发不按内容 key 吞掉合法的重复复制；轮询触发继续去重不变内容。`start()` 立即执行一次基线捕获，并保留低频兜底轮询。

```ts
captureChange(): Promise<void> {
  return this.enqueue(this.readSnapshot(), "change");
}

captureOnce(): Promise<void> {
  return this.enqueue(this.readSnapshot(), "poll");
}

drain(): Promise<void> {
  return this.tail;
}
```

- [ ] **Step 7: 添加并编译 Windows 消息助手**

`Program.cs` 使用 `AddClipboardFormatListener`、`GetClipboardSequenceNumber` 和消息窗口；启动输出 `READY <sequence>`，收到 `WM_CLIPBOARDUPDATE` 输出 `CHANGE <sequence>` 并 flush stdout。`buildClipboardListener.cjs` 调用系统 `csc.exe` 生成 `build/clipboard-listener.exe`。

- [ ] **Step 8: 接入 Electron 生命周期**

`index.ts` 在 `app.whenReady()` 后启动 monitor，并把事件交给 `watcher.captureChange()`；`before-quit` 停止 monitor/轮询，等待 `watcher.drain()` 后再退出。`package.json` 的 build 脚本先编译助手，并用 `extraResources` 把 exe 放到 `process.resourcesPath`。

- [ ] **Step 9: 验证 GREEN**

Run: `npx vitest run src/main/lib/clipboardChangeMonitor.test.ts src/main/lib/clipboardWatcher.test.ts`

Expected: 新增和原有采集测试全部通过。

### Task 3: 元数据可靠写入与退出排空

**Files:**
- Modify: `src/main/lib/historyStore.ts`
- Modify: `src/main/lib/historyStore.test.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: 写立即重载的失败测试**

`addText()` resolve 后立即构造第二个 `HistoryStore` 读取同一目录，必须看到刚写入的文本；当前 200ms fire-and-forget debounce 会使该断言失败。

```ts
await store.addText("must survive immediate restart");
const reloaded = new HistoryStore(dir, new MemoryKeyProvider(), settings);
await reloaded.init();
expect(await reloaded.list()).toMatchObject([
  { type: "text", text: "must survive immediate restart" }
]);
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/main/lib/historyStore.test.ts -t "survives immediate restart"`

Expected: FAIL，重载实例读不到最新项。

- [ ] **Step 3: 实现串行、可等待写入**

每次保存先快照 `this.items`，写 `history.json.tmp`，备份旧主文件，再替换主文件。所有写操作挂到同一 Promise chain；`saveMetadata()` 必须等待本次 revision 落盘，失败向调用方抛出。

```ts
private metadataWrite = Promise.resolve();

private saveMetadata(): Promise<void> {
  const json = JSON.stringify({ version: 1, items: this.items } satisfies MetadataFile);
  const write = this.metadataWrite.then(() => this.writeMetadataSnapshot(json));
  this.metadataWrite = write.catch(() => undefined);
  return write;
}

async flush(): Promise<void> {
  await this.metadataWrite;
}
```

- [ ] **Step 4: 覆盖失败恢复**

新增测试保证主文件损坏时仍从 `.bak` 恢复，且临时文件不会被当作有效元数据读取。

- [ ] **Step 5: 接入退出排空并验证 GREEN**

`index.ts` 的退出流程在 `watcher.drain()` 后调用 `store.flush()`。

Run: `npx vitest run src/main/lib/historyStore.test.ts`

Expected: 全部存储测试通过。

### Task 4: 让敏感过滤可见且默认完整记录

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/src/SettingsPane.tsx`
- Modify: `src/renderer/src/App.test.tsx`
- Modify: `src/shared/i18n.ts`
- Modify: `README.md`

- [ ] **Step 1: 写设置开关的失败测试**

渲染设置页后断言存在“敏感内容过滤”开关；点击后必须调用 `updateSettings({ sensitiveFilterEnabled: true })` 或 false，取决于当前状态。

```ts
fireEvent.click(screen.getByRole("checkbox", { name: /敏感内容过滤/ }));
await waitFor(() =>
  expect(api.updateSettings).toHaveBeenCalledWith({ sensitiveFilterEnabled: true })
);
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/renderer/src/App.test.tsx`

Expected: FAIL，当前设置页没有该控件。

- [ ] **Step 3: 沿用现有二元设置控件实现开关**

不改页面布局和配色，复用“开机启动”等开关的 DOM/CSS 结构；标签使用用户可识别的“敏感内容过滤”，说明文字只陈述会跳过验证码、密码和密钥。

- [ ] **Step 4: 默认关闭静默过滤**

把 `DEFAULT_SETTINGS.sensitiveFilterEnabled` 改为 `false`。保留过滤器实现和用户主动开启能力；README 同步说明默认完整记录、过滤可选。

- [ ] **Step 5: 验证 GREEN**

Run: `npx vitest run src/renderer/src/App.test.tsx src/main/lib/textFilter.test.ts`

Expected: UI 与过滤器测试全部通过。

### Task 5: 集成验证、备份与本机升级

**Files:**
- Modify mechanically: `package.json`, `package-lock.json` version to `0.1.1`
- Generate: `build/clipboard-listener.exe`
- Generate: `release/**`
- Preserve: `%APPDATA%/history-clipboard/**`

- [ ] **Step 1: 完整验证**

Run: `npm test`

Expected: 0 failures。

Run: `npm run build`

Expected: exit 0，`build/clipboard-listener.exe` 存在，`out/**` 生成成功。

- [ ] **Step 2: 打包安装程序**

Run: `npm run dist`

Expected: 生成 `release/历史剪贴板 Setup 0.1.1.exe` 与 `release/win-unpacked/`。

- [ ] **Step 3: 备份用户数据和旧安装**

备份目录使用带时间戳的新路径，不覆盖既有备份；校验 `history.json`、`vault.key`、`content/` 的文件数和 SHA-256 清单。不得读取或输出剪贴板明文。

- [ ] **Step 4: 升级当前用户配置**

仅把现有 `settings.json` 的 `sensitiveFilterEnabled` 改为 false，其他字段原样保留；修改前保留原文件副本。

- [ ] **Step 5: 安装并启动 0.1.1**

先从托盘正常退出旧进程，再安装新版本并启动。验证主进程、消息助手子进程、托盘和历史列表均正常。

- [ ] **Step 6: 端到端可靠性检查**

在先保存并最终恢复用户原剪贴板的前提下，连续写入带唯一标记的 A/B/C 文本；验证三条都进入加密历史元数据对应的哈希集合。不得在日志中输出实际内容。

- [ ] **Step 7: 最终审查**

检查 `git diff` 仅包含本计划涉及文件，运行完整测试和构建后再报告完成。
