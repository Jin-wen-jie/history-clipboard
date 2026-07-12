# 高可靠后台剪贴板捕获 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让应用在 Windows 登录后静默常驻，以受监督的原生助手近实时保存文本和图片快照，在助手故障时自动降级轮询，并完成可靠落盘、本机升级和 GitHub `v0.1.1` 发布。

**Architecture:** 同一用户会话中的 C# WinForms 助手监听 `WM_CLIPBOARDUPDATE`，在消息处理时把文本和图片复制进有界内存队列，再用版本化二进制帧传给 Electron。TypeScript 监督器负责握手、心跳、背压、异常重启和轮询降级；`ClipboardWatcher` 串行处理原生快照与轮询快照；`HistoryStore` 使用带 revision 的临时文件、主文件和备份完成原子恢复。启动项、升级迁移、状态 UI 和退出排空通过独立模块接入主进程。

**Tech Stack:** Electron 42、Node.js 24、TypeScript 5.7、React 19、Vitest 3、C# 5/.NET Framework 4.x WinForms、electron-vite、electron-builder、GitHub Actions

---

## 规格与执行约束

- 权威规格：`docs/superpowers/specs/2026-07-12-clipboard-background-reliability-design.md`
- 旧计划：`docs/superpowers/plans/2026-07-12-clipboard-capture-reliability.md`，只保留历史记录并标记为已被本计划替代。
- 当前分支：`fix/clipboard-capture-reliability`。
- 当前工作树已有 4 个未提交文件：`clipboardWatcher.ts/test`、`historyStore.ts/test`。这些改动属于可靠性基线，必须先验证并提交，禁止还原。
- 所有日志只允许状态、计数、序列号和错误码；禁止记录剪贴板正文、图片字节或 Base64。
- Task 15 备份完成前禁止运行会使用真实 `%APPDATA%/history-clipboard` 的 `npm run dev`；UI 只用
  jsdom 测试和打包后的安装应用验证，避免开发进程提前执行迁移。
- 任何任务失败时停在该任务内定位，不把多个猜测性修复堆到下一任务。
- 每次提交只暂存该任务列出的文件。

## 文件结构与职责

### 新建文件

- `native/clipboard-listener/NativeMethods.cs`：Win32 窗口、剪贴板、全局内存和图片格式 P/Invoke。
- `native/clipboard-listener/ClipboardSnapshotReader.cs`：同一打开周期复制 Unicode 文本及 PNG/DIB/DIBV5/位图。
- `native/clipboard-listener/AgentProtocol.cs`：协议 v1 帧头和二进制输出。
- `native/clipboard-listener/ClipboardFrameQueue.cs`：64 帧/64 MiB 有界队列和 overflow gap。
- `native/clipboard-listener/ClipboardListenerWindow.cs`：隐藏消息窗口、剪贴板消息和心跳。
- `native/clipboard-listener/Program.cs`：STA 生命周期、writer/stdin 线程、`PING`/`SHUTDOWN`/EOF。
- `native/clipboard-listener-tests/Program.cs`：不依赖第三方框架的 C# 协议与队列测试入口。
- `scripts/buildClipboardListener.cjs`：定位 Framework 4.x `csc.exe` 并构建生产/测试 EXE。
- `scripts/verifyClipboardListener.cjs`：黑盒验证 READY、PING、快照帧和 SHUTDOWN。
- `scripts/backupUserData.cjs`：只复制加密用户数据并生成 SHA-256 清单。
- `scripts/verifyClipboardCapture.cjs`：用已知标记做高速文本、重复内容和助手恢复验收，不解密历史正文。
- `src/main/lib/historyMetadata.ts`：StoredItem 类型、候选校验、revision、tmp/main/bak 原子提交与恢复。
- `src/main/lib/clipboardAgentProtocol.ts`：二进制流 parser 和严格帧校验。
- `src/main/lib/clipboardSequence.ts`：uint32 序列分类与回绕处理。
- `src/main/lib/clipboardAgentSupervisor.ts`：代次、握手、心跳、failure gate、退避和 stdout 背压。
- `src/main/lib/clipboardRuntime.ts`：组合 supervisor、watcher、Electron 图片适配和运行状态。
- `src/main/lib/settingsMigration.ts`：新装/旧版/损坏设置的纯迁移函数。
- `src/main/lib/startupManager.ts`：精确 Windows 登录项注册、查询、迁移和启动来源判断。
- `src/main/lib/shutdownCoordinator.ts`：可测试的一次性异步退出排空。
- 与上述 TypeScript 文件同目录的 `.test.ts` 文件。
- `src/renderer/src/StartupPrompt.tsx`：旧用户一次性后台启动选择。

### 修改文件

- `src/main/lib/secureVault.ts`：durable blob 写入、孤儿清理、密钥错误不覆盖。
- `src/main/lib/historyStore.ts`：使用 metadata journal、正确内容删除顺序、`flush()` 和设置迁移。
- `src/main/lib/clipboardWatcher.ts`：原生/轮询双路径、队列水位、停止接收和排空。
- `src/main/index.ts`：只负责模块接线、IPC、窗口/托盘和生命周期入口。
- `src/shared/types.ts`：设置迁移版本、启动状态、后台状态和受限设置 patch。
- `src/preload/index.ts`、`src/renderer/src/global.d.ts`：类型化启动项/后台状态 API。
- `src/renderer/src/useClipboardHistory.ts`、`App.tsx`、`SettingsPane.tsx`、`styles.css`、`App.test.tsx`：提示、状态和开关。
- `package.json`、`package-lock.json`、`.gitignore`、`scripts/afterPack.cjs`：原生构建与打包。
- `.github/workflows/ci.yml`、`.github/workflows/release.yml`：安装包和 tag/version 防护。
- `README.md` 和旧计划文档：新行为、边界和替代关系。

## 固定共享接口

后续任务必须使用下列名称，不能另起近义接口：

```ts
export type ClipboardSnapshot = {
  text: string;
  image?: ImageInput;
};

export type CaptureQueueState = {
  depth: number;
  bytes: number;
  backpressured: boolean;
};

export type ClipboardBackgroundMode =
  | "starting"
  | "listening"
  | "fallback"
  | "paused"
  | "stopped";

export type ClipboardBackgroundState = {
  mode: ClipboardBackgroundMode;
  helperPid: number | null;
  helperGeneration: number;
  lastEventAt: number | null;
  lastSequence: number | null;
  restartCount: number;
  nextRestartAt: number | null;
  gapCount: number;
  filteredCount: number;
  queueDepth: number;
  queueBytes: number;
  lastExit: { code: number | null; signal: string | null } | null;
  lastError: string | null;
};
```

```ts
export class ClipboardWatcher {
  startFallbackPolling(): void;
  stopFallbackPolling(): void;
  captureNative(snapshot: ClipboardSnapshot): Promise<void>;
  reconcileOnce(options?: { force?: boolean }): Promise<void>;
  stop(): void;
  drain(): Promise<void>;
  getQueueState(): CaptureQueueState;
}
```

```ts
export class ClipboardAgentSupervisor {
  start(): void;
  stop(): Promise<void>;
  handleSystemResume(): void;
  setOutputPaused(paused: boolean): void;
  getStatus(): ClipboardBackgroundState;
}
```

```ts
export const STARTUP_DECISION_VERSION = 1;

export type StartupState = {
  desiredEnabled: boolean;
  actualEnabled: boolean | null;
  pendingDecision: boolean;
  managed: boolean;
  error: "query-failed" | "apply-failed" | "state-mismatch" | null;
};
```

---

### Task 1: 固化当前可靠性基线

**Files:**
- Modify: `src/main/lib/clipboardWatcher.ts:21-171`
- Test: `src/main/lib/clipboardWatcher.test.ts:1-306`
- Modify: `src/main/lib/historyStore.ts:516-542`
- Test: `src/main/lib/historyStore.test.ts:1-134`

- [ ] **Step 1: 核对只包含现有四文件改动**

Run:

```powershell
git status --short
git diff -- src/main/lib/clipboardWatcher.ts src/main/lib/clipboardWatcher.test.ts src/main/lib/historyStore.ts src/main/lib/historyStore.test.ts
```

Expected: 只看到纯图片轮询测试、每 tick 全快照轮询、元数据串行等待和立即重载测试；不得出现设计文档回退或无关 UI 改动。

- [ ] **Step 2: 运行定向测试**

Run:

```powershell
npx vitest run src/main/lib/clipboardWatcher.test.ts src/main/lib/historyStore.test.ts
```

Expected: 2 files、20 tests 全部 PASS。

- [ ] **Step 3: 运行完整基线**

Run:

```powershell
npm test
npm run build
```

Expected: 27 tests PASS；TypeScript、main、preload、renderer 构建 exit 0。

- [ ] **Step 4: 提交基线**

```powershell
git add src/main/lib/clipboardWatcher.ts src/main/lib/clipboardWatcher.test.ts src/main/lib/historyStore.ts src/main/lib/historyStore.test.ts
git commit -m "fix: persist complete clipboard polling snapshots"
```

Expected: 只提交上述四文件。

---

### Task 2: 加固密钥与加密内容生命周期

**Files:**
- Modify: `src/main/lib/secureVault.ts:1-101`
- Test: `src/main/lib/secureVault.test.ts:1-32`

- [ ] **Step 1: 写密钥不可覆盖与孤儿清理失败测试**

在 `secureVault.test.ts` 增加：

```ts
test("does not replace an existing key when decryption fails", async () => {
  const keyPath = join(dir, "vault.key");
  await writeFile(keyPath, Buffer.from("existing-encrypted-key"));
  const protector = {
    isEncryptionAvailable: () => true,
    encryptString: vi.fn(() => Buffer.from("replacement")),
    decryptString: vi.fn(() => { throw new Error("cannot decrypt"); })
  };

  const provider = new SafeStorageKeyProvider(keyPath, protector);
  await expect(provider.getKey()).rejects.toThrow("cannot decrypt");
  expect(await readFile(keyPath, "utf8")).toBe("existing-encrypted-key");
  expect(protector.encryptString).not.toHaveBeenCalled();
});

test("removes only unreferenced encrypted blobs", async () => {
  const vault = new FileContentVault(dir, new MemoryKeyProvider(Buffer.alloc(32, 7)));
  await vault.write("keep.text", Buffer.from("keep"));
  await vault.write("drop.text", Buffer.from("drop"));

  await expect(vault.cleanupOrphans(new Set(["keep.text"]))).resolves.toBe(1);
  await expect(vault.read("keep.text")).resolves.toEqual(Buffer.from("keep"));
  await expect(vault.read("drop.text")).rejects.toMatchObject({ code: "ENOENT" });
});
```

同时保留现有“raw bytes 不含明文”断言。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
npx vitest run src/main/lib/secureVault.test.ts
```

Expected: FAIL，原因是 `cleanupOrphans` 不存在，且当前 key provider 会吞掉解密错误。

- [ ] **Step 3: 只在 ENOENT 时创建新密钥**

把 `SafeStorageKeyProvider.getKey()` 的读取分支改成：

```ts
try {
  const encrypted = await readFile(this.keyPath);
  this.key = Buffer.from(this.protector.decryptString(encrypted), "base64");
  return this.key;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
}

this.key = randomBytes(KEY_BYTES);
await mkdir(dirname(this.keyPath), { recursive: true });
await writeFile(this.keyPath, this.protector.encryptString(this.key.toString("base64")));
return this.key;
```

- [ ] **Step 4: 实现 durable write 与孤儿清理**

引入 `open`、`readdir`，让 `write()` 在 resolve 前 `sync()`，并新增：

```ts
async cleanupOrphans(referencedIds: ReadonlySet<string>): Promise<number> {
  const expected = new Set([...referencedIds].map((id) => `${safeId(id)}.bin`));
  const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error)
  );
  let removed = 0;
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".bin") && !expected.has(entry.name)) {
      await rm(join(this.rootDir, entry.name), { force: true });
      removed += 1;
    }
  }
  return removed;
}
```

`write()` 使用 `open(path, "w") -> writeFile(encrypted) -> sync() -> close()`，`close()` 放在 `finally`。

- [ ] **Step 5: 运行 GREEN 与提交**

```powershell
npx vitest run src/main/lib/secureVault.test.ts
git add src/main/lib/secureVault.ts src/main/lib/secureVault.test.ts
git commit -m "fix: harden encrypted content lifecycle"
```

Expected: secureVault 全部测试 PASS。

---

### Task 3: 实现带 revision 的原子元数据 journal

**Files:**
- Create: `src/main/lib/historyMetadata.ts`
- Create: `src/main/lib/historyMetadata.test.ts`
- Modify: `src/main/lib/historyStore.ts:1-74,516-564`
- Test: `src/main/lib/historyStore.test.ts`

- [ ] **Step 1: 写候选选择和旧格式兼容测试**

`historyMetadata.test.ts` 使用临时目录和一个最小 StoredItem，覆盖：

```ts
test("selects the highest valid revision and promotes it to main", async () => {
  await writeCandidate("history.json", { version: 1, revision: 1, items: [item("main")] });
  await writeCandidate("history.json.tmp", { version: 1, revision: 3, items: [item("temp")] });
  await writeCandidate("history.json.bak", { version: 1, revision: 2, items: [item("backup")] });

  const journal = new HistoryMetadataJournal(dir);
  const loaded = await journal.load();

  expect(loaded.revision).toBe(3);
  expect(loaded.items.map((entry) => entry.id)).toEqual(["temp"]);
  expect(JSON.parse(await readFile(join(dir, "history.json"), "utf8")).revision).toBe(3);
});

test("loads legacy metadata as revision zero", async () => {
  await writeCandidate("history.json", { version: 1, items: [item("legacy")] });
  const loaded = await new HistoryMetadataJournal(dir).load();
  expect(loaded).toMatchObject({ revision: 0, items: [{ id: "legacy" }] });
});

test("rejects a higher revision with malformed items", async () => {
  await writeCandidate("history.json", { version: 1, revision: 1, items: [item("valid")] });
  await writeCandidate("history.json.tmp", { version: 1, revision: 9, items: [{ id: 42 }] });
  const loaded = await new HistoryMetadataJournal(dir).load();
  expect(loaded.revision).toBe(1);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
npx vitest run src/main/lib/historyMetadata.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 定义存储类型与 journal 接口**

在 `historyMetadata.ts` 移入并导出 `StoredBase`、`StoredTextItem`、`StoredImageItem`、`StoredItem`，实现：

```ts
export type MetadataFile = {
  version: 1;
  revision: number;
  items: StoredItem[];
};

export type MetadataLoadResult = {
  revision: number;
  items: StoredItem[];
  hadCandidates: boolean;
  validCandidate: boolean;
  recovered: boolean;
};

export class HistoryMetadataJournal {
  constructor(private readonly rootDir: string) {}
  load(): Promise<MetadataLoadResult>;
  save(items: readonly StoredItem[]): Promise<number>;
  flush(): Promise<void>;
}
```

`load()` 固定检查 `history.json`、`history.json.tmp`、`history.json.bak`。先验证完整 StoredItem 结构，再按 revision 降序；同 revision 使用 main > temp > backup。旧 `{version:1,items}` 映射成 revision 0。

- [ ] **Step 4: 实现原子提交和可恢复写入链**

`save()` 在调用时深拷贝 items 并递增 revision；内部写入规则固定为：

```ts
const write = this.writeTail.then(() => this.writeSnapshot(snapshot));
this.latestWrite = write;
this.writeTail = write.catch(() => undefined);
return write.then(() => snapshot.revision);
```

`writeSnapshot()` 执行：同目录打开 `history.json.tmp`、完整写入、`sync()`、关闭；只把已验证 main 复制为 `.bak`；用 `rename(tmp, main)` 替换；失败时保留有效 `.bak`。`flush()` 返回 `latestWrite`。

- [ ] **Step 5: 接入 HistoryStore**

删除 `HistoryStore` 内部 `MetadataFile`、`saveChain`、`loadMetadata()` 文件操作，改为：

```ts
private readonly metadata: HistoryMetadataJournal;
private revision = 0;
private metadataRecoverable = true;

private async saveMetadata(): Promise<void> {
  this.revision = await this.metadata.save(this.items);
}

async flush(): Promise<void> {
  await this.metadata.flush();
}
```

`init()` 从 `metadata.load()` 恢复 items/revision，并保留 `hadCandidates`、`validCandidate` 和初始化前
`content` 是否存在，供 Task 4 决定是否清理孤儿。

- [ ] **Step 6: 运行测试与提交**

```powershell
npx vitest run src/main/lib/historyMetadata.test.ts src/main/lib/historyStore.test.ts
git add src/main/lib/historyMetadata.ts src/main/lib/historyMetadata.test.ts src/main/lib/historyStore.ts src/main/lib/historyStore.test.ts
git commit -m "fix: recover latest atomic history metadata"
```

Expected: 新旧 metadata 测试全部 PASS，已有历史可按 revision 0 读取。

---

### Task 4: 修正内容提交顺序、flush 与孤儿清理

**Files:**
- Modify: `src/main/lib/historyStore.ts:78-376,467-516`
- Test: `src/main/lib/historyStore.test.ts`
- Modify: `src/main/lib/historyMetadata.ts`

- [ ] **Step 1: 写删除顺序、flush 和孤儿测试**

增加以下断言：

```ts
test("commits removed metadata before deleting encrypted content", async () => {
  await store.addText("remove me");
  const stored = (await store.list())[0];
  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
  vi.spyOn((store as any).vault, "delete").mockImplementation(() => deleteGate);

  const deleting = store.delete(stored.id);
  await vi.waitFor(async () => {
    const disk = JSON.parse(await readFile(join(dir, "history.json"), "utf8"));
    expect(disk.items).toEqual([]);
  });
  releaseDelete();
  await expect(deleting).resolves.toBe(true);
});

test("flush waits for the latest revision", async () => {
  await store.addText("alpha");
  const item = (await store.list())[0];
  void store.setPinned(item.id, true);
  void store.setPinned(item.id, false);
  await store.flush();

  const reloaded = new HistoryStore(dir, keyProvider, settings, { now: () => currentTime });
  await reloaded.init();
  expect((await reloaded.list())[0].pinned).toBe(false);
});

test("cleans orphan blobs only when metadata is recoverable", async () => {
  await store.addText("kept");
  await writeFile(join(dir, "content", "orphan.text.bin"), Buffer.from("orphan"));
  const reloaded = new HistoryStore(dir, keyProvider, settings);
  await reloaded.init();
  await expect(stat(join(dir, "content", "orphan.text.bin"))).rejects.toMatchObject({ code: "ENOENT" });
});
```

另加“三个 metadata 候选全坏时不清空 content”的保护测试。

- [ ] **Step 2: 运行测试确认 RED**

```powershell
npx vitest run src/main/lib/historyStore.test.ts -t "metadata before|flush waits|orphan"
```

Expected: 当前删除顺序相反，`flush()` 不存在，孤儿不会清理。

- [ ] **Step 3: 统一移除事务顺序**

增加一个内部方法并让 `delete`、`deleteMany`、`clear`、retention 和 unreadable cleanup 都调用它：

```ts
private async commitRemoval(removed: StoredItem[]): Promise<void> {
  const removedIds = new Set(removed.map((item) => item.id));
  this.items = this.items.filter((item) => !removedIds.has(item.id));
  for (const id of removedIds) {
    this.itemCache.delete(id);
    this.invalidatedIds.delete(id);
  }
  await this.saveMetadata();
  const deletions = await Promise.allSettled(removed.map((item) => this.deleteContent(item)));
  for (const result of deletions) {
    if (result.status === "rejected") console.error("Encrypted content cleanup failed");
  }
}
```

禁止在 metadata 提交前删除任何被引用 blob。

- [ ] **Step 4: 在 init 后安全清理孤儿**

```ts
private referencedContentKeys(): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const item of this.items) {
    keys.add(item.contentKey);
    if (item.type === "image") keys.add(item.thumbnailKey);
  }
  return keys;
}
```

只有恢复出有效 metadata 候选，或初始化前完全没有 content 数据时才调用
`vault.cleanupOrphans()`。检测到候选全部损坏，或 metadata 缺失但已有 content 时，保留全部
content 并记录固定错误码，避免把可取证数据不可逆删除。

- [ ] **Step 5: 验证失败链可恢复**

增加测试：把 `history.json.tmp` 建成目录迫使一次写入 reject，删除该目录后下一次 `setPinned` 必须成功并能重载。确认 journal 使用 `latestWrite` 向当前调用传播失败、`writeTail.catch()` 保持后续可继续。

- [ ] **Step 6: 运行 GREEN 与提交**

```powershell
npx vitest run src/main/lib/secureVault.test.ts src/main/lib/historyMetadata.test.ts src/main/lib/historyStore.test.ts
git add src/main/lib/historyStore.ts src/main/lib/historyStore.test.ts src/main/lib/historyMetadata.ts
git commit -m "fix: order content and metadata commits"
```

Expected: 全部存储测试 PASS。

---

### Task 5: 实现 TypeScript 二进制协议与 sequence 分类

**Files:**
- Create: `src/main/lib/clipboardAgentProtocol.ts`
- Test: `src/main/lib/clipboardAgentProtocol.test.ts`
- Create: `src/main/lib/clipboardSequence.ts`
- Test: `src/main/lib/clipboardSequence.test.ts`

- [ ] **Step 1: 写 parser 分片与边界失败测试**

测试辅助函数只在测试文件内编码帧：

```ts
function encodeFrame(header: AgentFrameHeader, payload = Buffer.alloc(0)): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const frameLength = 4 + headerBytes.length + payload.length;
  const result = Buffer.allocUnsafe(4 + frameLength);
  result.writeUInt32LE(frameLength, 0);
  result.writeUInt32LE(headerBytes.length, 4);
  headerBytes.copy(result, 8);
  payload.copy(result, 8 + headerBytes.length);
  return result;
}
```

覆盖：一 chunk 多帧、每个字节单独 push、残缺头保留、`frameLength < 4`、超过 64 MiB、非法
JSON、非 UTF-8、unknown version/type、负数/小数 offset、分段越界、分段重叠、存在未声明 payload。

快照成功用例：

```ts
test("parses text and png from a fragmented snapshot frame", () => {
  const text = Buffer.from("hello", "utf8");
  const png = Buffer.from([137, 80, 78, 71]);
  const payload = Buffer.concat([text, png]);
  const encoded = encodeFrame({
    version: 1,
    type: "snapshot",
    sequence: 12,
    capturedAt: 1_783_828_800_000,
    text: { offset: 0, length: text.length },
    png: { offset: text.length, length: png.length, width: 1, height: 1 }
  }, payload);

  const parser = new ClipboardAgentFrameParser();
  expect(parser.push(encoded.subarray(0, 7))).toEqual([]);
  expect(parser.push(encoded.subarray(7))).toEqual([{
    version: 1,
    type: "snapshot",
    sequence: 12,
    capturedAt: 1_783_828_800_000,
    text: "hello",
    png,
    width: 1,
    height: 1
  }]);
});
```

- [ ] **Step 2: 写 sequence 回绕测试**

```ts
expect(classifySequence(10, 10)).toEqual({ kind: "duplicate", delta: 0 });
expect(classifySequence(10, 11)).toEqual({ kind: "next", delta: 1 });
expect(classifySequence(10, 13)).toEqual({ kind: "gap", delta: 3 });
expect(classifySequence(0xffff_ffff, 0)).toEqual({ kind: "next", delta: 1 });
expect(classifySequence(100, 99)).toEqual({ kind: "stale", delta: 0xffff_ffff });
```

- [ ] **Step 3: 运行测试确认 RED**

```powershell
npx vitest run src/main/lib/clipboardAgentProtocol.test.ts src/main/lib/clipboardSequence.test.ts
```

Expected: FAIL，两个模块不存在。

- [ ] **Step 4: 定义固定协议类型**

在 `clipboardAgentProtocol.ts` 导出：

```ts
export type AgentFrameHeader =
  | { version: 1; type: "ready"; pid: number; sequence: number; at: number }
  | { version: 1; type: "heartbeat"; sequence: number; at: number }
  | {
      version: 1;
      type: "snapshot";
      sequence: number;
      capturedAt: number;
      text?: { offset: number; length: number };
      png?: { offset: number; length: number; width: number; height: number };
    }
  | {
      version: 1;
      type: "gap";
      reason: "sequence-advanced" | "overflow" | "clipboard-busy";
      fromSequence?: number;
      toSequence: number;
      dropped: number;
      at: number;
    }
  | {
      version: 1;
      type: "error";
      code: "too-large" | "clipboard-busy" | "listener-failed" | "internal";
      sequence?: number;
      at: number;
    };

export type NativeClipboardSnapshot = {
  version: 1;
  type: "snapshot";
  sequence: number;
  capturedAt: number;
  text: string;
  png?: Buffer;
  width?: number;
  height?: number;
};

export type AgentControlFrame = Extract<
  AgentFrameHeader,
  { type: "ready" | "heartbeat" | "gap" | "error" }
>;

export type AgentFrame = AgentControlFrame | NativeClipboardSnapshot;

export class ClipboardAgentFrameParser {
  push(chunk: Buffer): AgentFrame[];
  reset(): void;
}
```

parser 完整帧后必须复制 payload 分段，不能让结果引用可继续增长的内部缓冲区。

- [ ] **Step 5: 实现 sequence 纯函数**

```ts
export function classifySequence(previous: number, next: number): SequenceChange {
  const delta = (next - previous) >>> 0;
  if (delta === 0) return { kind: "duplicate", delta };
  if (delta === 1) return { kind: "next", delta };
  if (delta < 0x8000_0000) return { kind: "gap", delta };
  return { kind: "stale", delta };
}
```

- [ ] **Step 6: 运行 GREEN 与提交**

```powershell
npx vitest run src/main/lib/clipboardAgentProtocol.test.ts src/main/lib/clipboardSequence.test.ts
git add src/main/lib/clipboardAgentProtocol.ts src/main/lib/clipboardAgentProtocol.test.ts src/main/lib/clipboardSequence.ts src/main/lib/clipboardSequence.test.ts
git commit -m "feat: add versioned clipboard agent protocol"
```

Expected: 两个测试文件全部 PASS。

---

### Task 6: 构建 C# 协议与有界帧队列

**Files:**
- Create: `native/clipboard-listener/AgentProtocol.cs`
- Create: `native/clipboard-listener/ClipboardFrameQueue.cs`
- Create: `native/clipboard-listener-tests/Program.cs`
- Create: `scripts/buildClipboardListener.cjs`
- Modify: `package.json:scripts`
- Modify: `.gitignore`

- [ ] **Step 1: 写无框架 C# 队列测试入口**

`native/clipboard-listener-tests/Program.cs` 使用失败即 `Environment.Exit(1)` 的断言函数，执行
“正常 FIFO、帧数溢出、字节数溢出、单帧过大”四类断言；核心用例如下：

```csharp
private static void QueueDropsOldestAndReportsGap()
{
    ClipboardFrameQueue queue = new ClipboardFrameQueue(2, 32);
    queue.Enqueue(AgentFrame.Snapshot(1, new byte[12]));
    queue.Enqueue(AgentFrame.Snapshot(2, new byte[12]));
    queue.Enqueue(AgentFrame.Snapshot(3, new byte[12]));

    AgentFrame first = queue.Take(CancellationToken.None);
    AgentFrame second = queue.Take(CancellationToken.None);
    AgentFrame third = queue.Take(CancellationToken.None);
    AssertEqual("gap", first.Type);
    AssertEqual(1, first.Dropped);
    AssertEqual((uint)2, second.Sequence);
    AssertEqual((uint)3, third.Sequence);
}

private static void RejectsSingleOversizeFrame()
{
    ClipboardFrameQueue queue = new ClipboardFrameQueue(64, 64 * 1024 * 1024);
    queue.Enqueue(AgentFrame.Snapshot(9, new byte[64 * 1024 * 1024 + 1]));
    AssertEqual("error", queue.Take(CancellationToken.None).Type);
}
```

- [ ] **Step 2: 写构建脚本并确认 RED**

`buildClipboardListener.cjs` 固定查找：

```js
const candidates = [
  `${process.env.WINDIR}\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe`,
  `${process.env.WINDIR}\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe`
];
```

测试构建使用 `/target:exe /out:build/clipboard-listener-tests.exe`，生产构建稍后加入全部源文件。
两个构建都显式引用 `System.dll`、`System.Core.dll`、`System.Windows.Forms.dll`、
`System.Drawing.dll`、`System.Web.Extensions.dll`；`AgentProtocol.ToJson()` 使用
`System.Web.Script.Serialization.JavaScriptSerializer`，不手拼用户可控 JSON。

Run:

```powershell
node scripts/buildClipboardListener.cjs --tests
```

Expected: FAIL，`AgentProtocol.cs` 与 `ClipboardFrameQueue.cs` 尚不存在。

- [ ] **Step 3: 实现 AgentFrame 和二进制写入器**

`AgentProtocol.cs` 必须兼容 C# 5，不使用插值字符串、records 或 `using var`。核心写入：

```csharp
public static void WriteFrame(Stream output, AgentFrame frame)
{
    byte[] header = Encoding.UTF8.GetBytes(frame.ToJson());
    int frameLength = checked(4 + header.Length + frame.Payload.Length);
    BinaryWriter writer = new BinaryWriter(output, Encoding.UTF8, true);
    writer.Write((uint)frameLength);
    writer.Write((uint)header.Length);
    writer.Write(header);
    writer.Write(frame.Payload);
    writer.Flush();
}
```

JSON 只由白名单字段组成；字符串值只来自固定枚举，不拼接异常正文。

- [ ] **Step 4: 实现双限制队列**

`ClipboardFrameQueue` 构造参数为 `maxFrames`、`maxBytes`，字节预算只计算 payload。enqueue snapshot 超限时从最旧 snapshot
开始丢弃，累计 dropped，保证最新 snapshot 能入队，并让下一次 `Take()` 先返回 overflow gap。
控制帧不计入 snapshot 条数，但计入总字节；单帧超上限返回 `too-large` error。

- [ ] **Step 5: 运行 C# 测试 GREEN**

```powershell
node scripts/buildClipboardListener.cjs --tests
& .\build\clipboard-listener-tests.exe
```

Expected: exit 0，并输出唯一一行 `clipboard-listener-tests: PASS`。

- [ ] **Step 6: 接入 npm 命令并提交**

`package.json` 先增加：

```json
"build:helper": "node scripts/buildClipboardListener.cjs",
"test:helper": "node scripts/buildClipboardListener.cjs --tests && build\\clipboard-listener-tests.exe"
```

`.gitignore` 增加：

```gitignore
build/clipboard-listener.exe
build/clipboard-listener-tests.exe
```

Run and commit:

```powershell
npm run test:helper
git add native/clipboard-listener/AgentProtocol.cs native/clipboard-listener/ClipboardFrameQueue.cs native/clipboard-listener-tests/Program.cs scripts/buildClipboardListener.cjs package.json .gitignore
git commit -m "feat: add bounded native clipboard frame queue"
```

---

### Task 7: 实现原生剪贴板快照助手

**Files:**
- Create: `native/clipboard-listener/NativeMethods.cs`
- Create: `native/clipboard-listener/ClipboardSnapshotReader.cs`
- Create: `native/clipboard-listener/ClipboardListenerWindow.cs`
- Create: `native/clipboard-listener/Program.cs`
- Create: `scripts/verifyClipboardListener.cjs`
- Modify: `scripts/buildClipboardListener.cjs`

- [ ] **Step 1: 写 helper 黑盒验证脚本**

`verifyClipboardListener.cjs` spawn 传入 EXE，设置 `windowsHide:true`，用 Task 5 parser 解析 stdout；断言：

```js
await waitForFrame((frame) => frame.type === "ready" && frame.version === 1, 3000);
child.stdin.write("PING\n");
await waitForFrame((frame) => frame.type === "heartbeat", 3000);
child.stdin.write("SHUTDOWN\n");
await expectExit(child, 0, 3000);
assert.equal(stderr, "");
```

增加 `--self-test` 模式断言一帧文本 `self-test` 和 1x1 PNG 能被 TypeScript parser 解析。

- [ ] **Step 2: 运行脚本确认 RED**

```powershell
npm run build:helper
node scripts/verifyClipboardListener.cjs build/clipboard-listener.exe
```

Expected: FAIL，生产 EXE 或 READY 协议尚不存在。

- [ ] **Step 3: 实现 Win32 声明与隐藏窗口**

`NativeMethods.cs` 声明 `AddClipboardFormatListener`、`RemoveClipboardFormatListener`、
`OpenClipboard`、`CloseClipboard`、`GetClipboardData`、`IsClipboardFormatAvailable`、
`GetClipboardSequenceNumber`、`GlobalLock`、`GlobalUnlock`、`GlobalSize`、`RegisterClipboardFormat`。

`ClipboardListenerWindow.WndProc` 固定为：

```csharp
protected override void WndProc(ref Message message)
{
    if (message.Msg == NativeMethods.WM_CLIPBOARDUPDATE)
    {
        _onClipboardChanged();
    }
    base.WndProc(ref message);
}
```

构造时创建 message-only handle 并注册 listener；Dispose 时注销并销毁 handle。

- [ ] **Step 4: 实现同一打开周期快照**

`ClipboardSnapshotReader.TryCapture()`：

```csharp
public SnapshotResult TryCapture()
{
    uint before = NativeMethods.GetClipboardSequenceNumber();
    if (!OpenWithRetry(TimeSpan.FromSeconds(1)))
        return SnapshotResult.Gap("clipboard-busy", before);
    try
    {
        string text = ReadUnicodeText();
        PngResult image = ReadPngOrBitmap();
        uint after = NativeMethods.GetClipboardSequenceNumber();
        return SnapshotResult.Success(after, text, image);
    }
    finally
    {
        NativeMethods.CloseClipboard();
    }
}
```

图片优先顺序固定：注册的 `PNG` -> `CF_DIBV5` -> `CF_DIB` -> `CF_BITMAP`。关闭剪贴板前必须把
句柄数据复制到自有内存；DIB/位图转 PNG 可在关闭后完成。重试期间 sequence 前进时先 emit
`sequence-advanced` gap，再捕获当前状态。

- [ ] **Step 5: 实现 STA、writer、心跳与父进程绑定**

`Program.Main` 标记 `[STAThread]`，创建 64/64 MiB queue、writer thread 和 listener window；
每 5 秒 enqueue heartbeat。stdin reader 只接受 `PING`、`SHUTDOWN`，EOF 等价于 shutdown。
writer 是唯一写 stdout 的线程。所有 catch 只发固定 error code，stderr 不写异常 message。

- [ ] **Step 6: 运行 helper 验证**

```powershell
npm run build:helper
node scripts/verifyClipboardListener.cjs build/clipboard-listener.exe
npm run test:helper
```

Expected: READY、self-test snapshot、PING heartbeat、SHUTDOWN 均通过；C# tests PASS。

- [ ] **Step 7: 提交助手**

```powershell
git add native/clipboard-listener scripts/buildClipboardListener.cjs scripts/verifyClipboardListener.cjs
git commit -m "feat: capture clipboard snapshots in native agent"
```

---

### Task 8: 将 ClipboardWatcher 改为原生/轮询双路径队列

**Files:**
- Modify: `src/main/lib/clipboardWatcher.ts`
- Test: `src/main/lib/clipboardWatcher.test.ts`

- [ ] **Step 1: 写原生重复、轮询合并与背压测试**

新增测试必须包含：

```ts
test("persists identical native snapshots as separate copy events", async () => {
  const addText = vi.fn().mockResolvedValue({ ok: true });
  const watcher = createWatcher({ addText });
  const snapshot = { text: "same", image: undefined };
  await watcher.captureNative(snapshot);
  await watcher.captureNative(snapshot);
  expect(addText).toHaveBeenCalledTimes(2);
});

test("backpressures native input without dropping snapshots", async () => {
  const gate = deferred<void>();
  const calls: string[] = [];
  const backpressure = vi.fn();
  const watcher = createWatcher({
    highWaterItems: 2,
    lowWaterItems: 1,
    onBackpressureChange: backpressure,
    addText: async (text) => { if (text === "A") await gate.promise; calls.push(text); return ok(text); }
  });
  const captures = ["A", "B", "C"].map((text) => watcher.captureNative({ text }));
  expect(backpressure).toHaveBeenCalledWith(true);
  gate.resolve();
  await Promise.all(captures);
  expect(calls).toEqual(["A", "B", "C"]);
  expect(backpressure).toHaveBeenLastCalledWith(false);
});
```

另测：poll 被阻塞时第二个 poll 合并；poll 相同内容只写一次；`stop()` 后新 native resolve 但不入队；
`drain()` 等到最后 native；敏感/too-large poll 不每 200ms 重试，设置变化后 force reconcile。

- [ ] **Step 2: 运行测试确认 RED**

```powershell
npx vitest run src/main/lib/clipboardWatcher.test.ts -t "native|backpressure|coalesces|force"
```

Expected: FAIL，缺少 `captureNative`、水位回调和 fallback API。

- [ ] **Step 3: 固定 options 与公开 API**

```ts
export type ClipboardWatcherOptions = {
  getSettings: () => Promise<AppSettings>;
  readImage: () => ImageInput | undefined;
  readText: () => string;
  addImage: (input: ImageInput) => Promise<HistoryResult> | HistoryResult;
  addText: (text: string) => Promise<HistoryResult> | HistoryResult;
  fallbackIntervalMs?: number;
  highWaterItems?: number;
  lowWaterItems?: number;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  onBackpressureChange?: (paused: boolean) => void;
  onQueueStateChange?: (state: CaptureQueueState) => void;
  onFiltered?: (reason: "sensitive" | "too-large") => void;
};
```

默认 high 为 32 items/32 MiB，low 为 16 items/16 MiB。删除 `pendingCaptures > 10` 的静默 return。

- [ ] **Step 4: 区分 native 与 poll 处理语义**

内部队列项包含 `{source:"native"|"poll",snapshot,bytes}`。`native` 永不按 hash 跳过；`poll`
更新 `lastTextKey/lastImageKey` 并合并同一时刻只允许一个 pending poll。每个 native 完成后也更新
poll keys，避免刚切 fallback 时重复计数。

非 ok poll 结果记录被拒绝 fingerprint；`sensitive` 与 `too-large` 通过 `onFiltered` 增加不含正文的
运行时计数。当 `reconcileOnce({force:true})` 时清空 keys/fingerprint，重新处理当前值。

- [ ] **Step 5: 实现高低水位与停止语义**

enqueue 后若跨 high，恰好调用一次 `onBackpressureChange(true)`；处理后同时低于两个 low 再调用
`false`。`stop()` 先停止 timer，再设置 `accepting=false`；已经入队的项仍由 `drain()` 排空。

- [ ] **Step 6: 运行 GREEN 与提交**

```powershell
npx vitest run src/main/lib/clipboardWatcher.test.ts
git add src/main/lib/clipboardWatcher.ts src/main/lib/clipboardWatcher.test.ts
git commit -m "feat: queue native clipboard snapshots without deduplication"
```

Expected: watcher 全部测试 PASS，不再有静默丢 native 的路径。

---

### Task 9: 实现助手监督器状态机

**Files:**
- Create: `src/main/lib/clipboardAgentSupervisor.ts`
- Test: `src/main/lib/clipboardAgentSupervisor.test.ts`
- Create: `src/main/lib/clipboardAgent.integration.test.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 写握手、failure gate 和退避测试**

使用 fake child、fake timers 和注入 spawn，覆盖：

```ts
test("restarts once when error and close belong to the same generation", () => {
  const harness = createSupervisorHarness();
  harness.supervisor.start();
  harness.child.emit("error", new Error("spawn failed"));
  harness.child.emit("close", 1, null);
  vi.advanceTimersByTime(600);
  expect(harness.spawn).toHaveBeenCalledTimes(2);
});

test("ignores late frames from an old generation", () => {
  const harness = createSupervisorHarness();
  harness.supervisor.start();
  const oldStdout = harness.child.stdout;
  harness.failCurrent();
  vi.advanceTimersByTime(600);
  oldStdout.emit("data", encodeReady(999));
  expect(harness.onSnapshot).not.toHaveBeenCalled();
  expect(harness.supervisor.getStatus().helperPid).not.toBe(999);
});
```

另测：3 秒 READY 超时、15 秒心跳超时、0.5/1/2/4/8/16/30 秒退避、`nextRestartAt`、20% jitter 范围、
连续健康 60 秒复位、退出码 0 但 desiredRunning=true 仍重启、各状态 stop、stop 后不重启。

- [ ] **Step 2: 写 sequence/gap 与 pause/resume 测试**

断言 duplicate 忽略、next 接受、gap 增加 `gapCount` 并触发 reconcile、stale 忽略；
`setOutputPaused(true/false)` 只作用当前 generation stdout，旧 stdout 不恢复。

- [ ] **Step 3: 运行测试确认 RED**

```powershell
npx vitest run src/main/lib/clipboardAgentSupervisor.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现注入式 supervisor**

```ts
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
```

状态必须显式使用 `stopped|starting|running|backoff|stopping` 和递增 generation。所有 error/close/
stdout-end/timeout 进入一个按 generation 去重的 `failGeneration()`。

- [ ] **Step 5: 接入 parser、sequence 与背压**

只有首个合法 ready 才进入 running。snapshot 在调用 `onSnapshot` 前复制完成；heartbeat 携带 sequence，
若与最后处理值不一致则记 gap 并 `onReconcile()`。stderr 只映射到固定 `helper-stderr` 错误码，
不把原始内容传给 console。

- [ ] **Step 6: 写真实 EXE 集成测试**

`clipboardAgent.integration.test.ts` 仅在 `process.platform === "win32"` 运行，spawn `build/clipboard-listener.exe --self-test`，断言 ready、snapshot、正常 stop，不读取真实用户剪贴板。

- [ ] **Step 7: 运行 GREEN 与提交**

```powershell
npm run build:helper
npx vitest run src/main/lib/clipboardAgentSupervisor.test.ts src/main/lib/clipboardAgent.integration.test.ts
git add src/main/lib/clipboardAgentSupervisor.ts src/main/lib/clipboardAgentSupervisor.test.ts src/main/lib/clipboardAgent.integration.test.ts src/shared/types.ts
git commit -m "feat: supervise clipboard agent health and restart"
```

---

### Task 10: 实现设置迁移矩阵

**Files:**
- Create: `src/main/lib/settingsMigration.ts`
- Test: `src/main/lib/settingsMigration.test.ts`
- Modify: `src/shared/types.ts:31-88`
- Modify: `src/main/lib/historyStore.ts:65-82,256-266,565-581`
- Test: `src/main/lib/historyStore.test.ts`
- Modify: 所有构造完整 `AppSettings` 的测试文件

- [ ] **Step 1: 写六类迁移表测试**

固定输入类型：

```ts
export type InstallationEvidence = {
  settingsExists: boolean;
  settingsCorrupt: boolean;
  historyExists: boolean;
  vaultKeyExists: boolean;
  contentExists: boolean;
};

export function migrateSettings(
  raw: Partial<AppSettings> | undefined,
  evidence: InstallationEvidence
): AppSettings;
```

使用 `test.each` 覆盖：

```ts
const noEvidence = (): InstallationEvidence => ({
  settingsExists: false,
  settingsCorrupt: false,
  historyExists: false,
  vaultKeyExists: false,
  contentExists: false
});
const oldEvidence = (): InstallationEvidence => ({
  settingsExists: true,
  settingsCorrupt: false,
  historyExists: true,
  vaultKeyExists: true,
  contentExists: true
});

test.each([
  ["new install", undefined, noEvidence(), true, 1],
  ["legacy enabled", { launchAtStartup: true }, oldEvidence(), true, 1],
  ["legacy disabled", { launchAtStartup: false }, oldEvidence(), false, 0],
  ["legacy missing flag", { captureEnabled: true }, oldEvidence(), false, 0],
  ["corrupt settings with history", undefined, { ...oldEvidence(), settingsCorrupt: true }, false, 0],
  ["decided disabled", { launchAtStartup: false, startupDecisionVersion: 1 }, oldEvidence(), false, 1]
])("migrates %s", (_name, raw, evidence, launchAtStartup, startupDecisionVersion) => {
  expect(migrateSettings(raw as Partial<AppSettings> | undefined, evidence)).toMatchObject({
    launchAtStartup,
    startupDecisionVersion
  });
});
```

断言所有旧 schema 迁移后 `sensitiveFilterEnabled=false`；已有 `startupDecisionVersion:1` 时保留用户
之后设置的过滤值。

- [ ] **Step 2: 运行测试确认 RED**

```powershell
npx vitest run src/main/lib/settingsMigration.test.ts
```

Expected: FAIL，模块与 `startupDecisionVersion` 不存在。

- [ ] **Step 3: 更新共享设置类型和默认值**

```ts
export const STARTUP_DECISION_VERSION = 1;

export type AppSettings = {
  captureEnabled: boolean;
  maxItems: number;
  retentionDays: number;
  maxTextLength: number;
  maxImageBytes: number;
  hotkey: string;
  launchAtStartup: boolean;
  startupDecisionVersion: number;
  sensitiveFilterEnabled: boolean;
};

export const DEFAULT_SETTINGS: AppSettings = {
  captureEnabled: true,
  maxItems: 500,
  retentionDays: 30,
  maxTextLength: 20_000,
  maxImageBytes: 10 * 1024 * 1024,
  hotkey: "Ctrl+Alt+V",
  launchAtStartup: true,
  startupDecisionVersion: STARTUP_DECISION_VERSION,
  sensitiveFilterEnabled: false
};
```

更新所有测试 settings literal，不能用 `as AppSettings` 掩盖缺字段。

- [ ] **Step 4: 实现纯迁移函数**

`settingsMigration.ts` 先判定 `hasExistingEvidence`。只有完全没有 settings/history/vault/content 才按
新装。旧 schema 的 false/缺失/损坏都变成 false+0；旧 true 变成 true+1；已是版本 1 时保留。

- [ ] **Step 5: 在创建 content 目录前收集 evidence**

`HistoryStore.init()` 顺序改成：

```ts
const evidence = await this.detectInstallationEvidence();
await mkdir(this.contentDir, { recursive: true });
await this.loadSettings(evidence);
const metadata = await this.loadMetadata();
await this.cleanupOrphansWhenSafe(metadata);
```

读取原始 JSON 失败时把 `settingsCorrupt=true` 交给迁移函数，禁止立即覆盖成新装默认。迁移结果与
原始文件不同才保存。

- [ ] **Step 6: 运行 GREEN 与提交**

```powershell
npx vitest run src/main/lib/settingsMigration.test.ts src/main/lib/historyStore.test.ts src/main/lib/textFilter.test.ts
git add src/shared/types.ts src/main/lib/settingsMigration.ts src/main/lib/settingsMigration.test.ts src/main/lib/historyStore.ts src/main/lib/historyStore.test.ts src/main/lib/textFilter.test.ts src/main/lib/clipboardWatcher.test.ts src/renderer/src/App.test.tsx
git commit -m "feat: migrate startup preferences safely"
```

Expected: 六类迁移和全部受影响类型测试 PASS。

---

### Task 11: 精确管理 Windows 登录启动项与启动来源

**Files:**
- Create: `src/main/lib/startupManager.ts`
- Test: `src/main/lib/startupManager.test.ts`
- Modify: `src/main/index.ts:36-97,305-317`

- [ ] **Step 1: 写启动来源纯函数测试**

```ts
expect(isLaunchAtLogin(["app.exe", "--launch-at-login"])).toBe(true);
expect(isLaunchAtLogin(["app.exe"])).toBe(false);
expect(shouldShowForSecondInstance(["app.exe", "--launch-at-login"])).toBe(false);
expect(shouldShowForSecondInstance(["app.exe"])).toBe(true);
```

- [ ] **Step 2: 写注册、查询和失败测试**

注入一个只含 `isPackaged`、`setLoginItemSettings`、`getLoginItemSettings` 的 fake app。覆盖：

- 开启前用空 args 注销旧项，再用 `--launch-at-login` 注册新项。
- 关闭时同时注销空 args 和新 args。
- 开发模式不调用系统 API，返回 `managed=false`。
- `launchItems` 中 path/args 精确匹配且 `enabled=true` 才是 actual true。
- query throw -> `actualEnabled=null,error="query-failed"`。
- apply throw 后设置仍保存 desired+decision version，返回 `apply-failed`。
- desired 与 actual 不同 -> `state-mismatch`。

- [ ] **Step 3: 运行测试确认 RED**

```powershell
npx vitest run src/main/lib/startupManager.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 4: 定义 manager 依赖与固定参数**

```ts
export const LOGIN_ITEM_ARG = "--launch-at-login";
const LOGIN_ITEM_ARGS = [LOGIN_ITEM_ARG];

export type StartupSettingsStore = {
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
};

export type LoginItemApp = Pick<
  Electron.App,
  "isPackaged" | "setLoginItemSettings" | "getLoginItemSettings"
>;

export class StartupManager {
  constructor(
    private readonly electronApp: LoginItemApp,
    private readonly settingsStore: StartupSettingsStore,
    private readonly executablePath = process.execPath
  ) {}
  getState(): Promise<StartupState>;
  setEnabled(enabled: boolean): Promise<StartupState>;
  reconcile(): Promise<StartupState>;
}
```

- [ ] **Step 5: 实现 desired/actual 分离**

`setEnabled()` 先持久化 `{launchAtStartup:enabled,startupDecisionVersion:1}`，再执行系统操作；失败不
回滚用户期望。`getState()` 使用 `getLoginItemSettings({path, args:LOGIN_ITEM_ARGS})` 和精确
`launchItems`。`pendingDecision` 只由 version `< 1` 决定。

- [ ] **Step 6: 修正主进程显示逻辑**

在 `bootstrap()` 末尾只使用：

```ts
if (!isLaunchAtLogin(process.argv)) mainWindow?.show();
```

第二实例 handler 接收 commandLine：

```ts
app.on("second-instance", (_event, commandLine) => {
  if (!shouldShowForSecondInstance(commandLine)) return;
  if (mainWindow) showWindow();
  else pendingShow = true;
});
```

`createWindow()` 完成后若 `pendingShow` 为 true，清除标记并调用 `showWindow()`；增加第二实例早于
窗口创建的测试，不能丢掉用户的手动打开意图。

把当前 `applySystemSettings()` 拆成只管理全局热键；登录项只经 StartupManager。

- [ ] **Step 7: 运行 GREEN 与提交**

```powershell
npx vitest run src/main/lib/startupManager.test.ts
npm run build
git add src/main/lib/startupManager.ts src/main/lib/startupManager.test.ts src/main/index.ts
git commit -m "feat: manage Windows login startup state"
```

---

### Task 12: 组合捕获运行时并实现异步退出排空

**Files:**
- Create: `src/main/lib/clipboardRuntime.ts`
- Test: `src/main/lib/clipboardRuntime.test.ts`
- Create: `src/main/lib/shutdownCoordinator.ts`
- Test: `src/main/lib/shutdownCoordinator.test.ts`
- Modify: `src/main/index.ts:1-110,305-396`
- Modify: `src/main/lib/historyStore.ts`

- [ ] **Step 1: 写 runtime 模式切换测试**

使用 fake watcher/supervisor，断言：

```ts
test("uses fallback polling until the helper is ready", async () => {
  const harness = createRuntimeHarness();
  harness.runtime.start();
  expect(harness.watcher.startFallbackPolling).toHaveBeenCalled();
  harness.emitStatus({ mode: "listening" });
  expect(harness.watcher.stopFallbackPolling).toHaveBeenCalled();
  expect(harness.watcher.reconcileOnce).toHaveBeenCalledWith({ force: true });
  harness.emitStatus({ mode: "fallback" });
  expect(harness.watcher.startFallbackPolling).toHaveBeenCalledTimes(2);
});
```

另测 native frame 的 PNG 用注入 `createImageInput(png,width,height)` 生成缩略图后交给 watcher；
watcher high/low 回调调用 supervisor pause/resume；resume 强制 reconcile。

- [ ] **Step 2: 写 ShutdownCoordinator 严格顺序测试**

```ts
expect(order).toEqual([
  "stop-supervisor",
  "stop-watcher",
  "drain-watcher",
  "flush-store",
  "unregister-shortcuts",
  "quit"
]);
```

首次 before-quit 必须 preventDefault；重复事件不启动第二条链；完成后的第二次事件不阻止；
flush reject 仍调用 `onError`、unregister 和 quit。

- [ ] **Step 3: 运行测试确认 RED**

```powershell
npx vitest run src/main/lib/clipboardRuntime.test.ts src/main/lib/shutdownCoordinator.test.ts
```

Expected: FAIL，两个模块不存在。

- [ ] **Step 4: 实现 ClipboardRuntime**

```ts
export class ClipboardRuntime {
  start(): void;
  stopProducers(): Promise<void>;
  drain(): Promise<void>;
  handleSystemResume(): void;
  reconcileAfterSettingsChange(): Promise<void>;
  getState(): ClipboardBackgroundState;
}
```

helper 路径固定：打包时 `join(process.resourcesPath,"clipboard-listener.exe")`；开发时
`join(currentDir,"../../build/clipboard-listener.exe")`。启动先开 fallback，再 start supervisor。
supervisor listening 后停止 fallback 并 force reconcile；任何 failure/backoff 立即恢复 200ms fallback。

- [ ] **Step 5: 实现一次性退出协调器**

```ts
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
  constructor(private readonly deps: ShutdownDependencies) {}
  get isQuitting(): boolean;
  handleBeforeQuit(event: { preventDefault(): void }): void;
}
```

内部用单个 shutdown Promise 和 `shutdownComplete` gate，顺序严格匹配测试。

- [ ] **Step 6: 主进程接线**

- `bootstrap()` 在 store.init/startup.reconcile 后创建 ClipboardRuntime。
- `powerMonitor.on("resume")` 调 `runtime.handleSystemResume()`。
- 托盘“退出”只调用 `app.quit()`，不提前 stop 或设置互相冲突的 flags。
- `before-quit` 只委托 coordinator。
- `HistoryStore.flush()` 直接委托 metadata journal。

- [ ] **Step 7: 运行 GREEN 与提交**

```powershell
npx vitest run src/main/lib/clipboardRuntime.test.ts src/main/lib/shutdownCoordinator.test.ts
npm test
npm run build
git add src/main/lib/clipboardRuntime.ts src/main/lib/clipboardRuntime.test.ts src/main/lib/shutdownCoordinator.ts src/main/lib/shutdownCoordinator.test.ts src/main/index.ts src/main/lib/historyStore.ts
git commit -m "feat: integrate supervised clipboard capture lifecycle"
```

---

### Task 13: 增加启动提示、后台状态与敏感过滤 UI

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/global.d.ts`
- Modify: `src/renderer/src/useClipboardHistory.ts`
- Modify: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/StartupPrompt.tsx`
- Modify: `src/renderer/src/SettingsPane.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `src/renderer/src/App.test.tsx`
- Modify: `src/main/index.ts` IPC section

- [ ] **Step 1: 固定共享 API 类型**

```ts
export type EditableSettingsPatch = Partial<
  Omit<AppSettings, "launchAtStartup" | "startupDecisionVersion">
>;

export type ClipboardHistoryApi = {
  list(query?: HistoryQuery): Promise<HistoryItem[]>;
  copy(id: string): Promise<{ ok: boolean }>;
  delete(id: string): Promise<{ ok: boolean }>;
  deleteMany(ids: string[]): Promise<{ ok: boolean; count: number }>;
  clear(type?: HistoryFilterType): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<{ ok: boolean }>;
  getSettings(): Promise<AppSettings>;
  updateSettings(settings: EditableSettingsPatch): Promise<AppSettings>;
  getStats(): Promise<StorageStats>;
  showWindow(): Promise<void>;
  exportHistory(): Promise<{ ok: boolean; reason?: string }>;
  importHistory(): Promise<{ ok: boolean; reason?: string; imported?: number; skipped?: number }>;
  getStartupState(): Promise<StartupState>;
  setStartupEnabled(enabled: boolean): Promise<StartupState>;
  getBackgroundState(): Promise<ClipboardBackgroundState>;
};
```

preload IPC 固定为 `startup:getState`、`startup:setEnabled`、`background:getState`。通用
`settings:update` 在主进程拒绝 `launchAtStartup` 和 `startupDecisionVersion` 字段。

- [ ] **Step 2: 扩展 App 测试 mock 并写 UI RED 测试**

`mockClipHistory()` 补三个 API。增加：

```ts
test("asks an undecided legacy user once", async () => {
  const setStartupEnabled = vi.fn().mockResolvedValue(enabledStartupState());
  window.clipHistory = mockClipHistory({
    getStartupState: vi.fn().mockResolvedValue({
      desiredEnabled: false,
      actualEnabled: false,
      pendingDecision: true,
      managed: true,
      error: null
    }),
    setStartupEnabled
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "启用后台记录" }));
  await waitFor(() => expect(setStartupEnabled).toHaveBeenCalledWith(true));
});

test("toggles the visible sensitive filter", async () => {
  const updateSettings = vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, sensitiveFilterEnabled: true });
  window.clipHistory = mockClipHistory({ updateSettings });
  render(<App />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "敏感内容过滤" }));
  expect(updateSettings).toHaveBeenCalledWith({ sensitiveFilterEnabled: true });
});
```

用 `test.each` 覆盖 `正常监听`、`轮询降级`、`已暂停`、`启动项异常`。

- [ ] **Step 3: 运行测试确认 RED**

```powershell
npx vitest run src/renderer/src/App.test.tsx
```

Expected: FAIL，API、提示和状态元素不存在。

- [ ] **Step 4: 扩展 hook 数据加载与动作**

`load()` 同时获取 settings、stats、items、startupState、backgroundState。新增：

```ts
async function setStartupEnabled(enabled: boolean): Promise<void> {
  setStartupState(await window.clipHistory.setStartupEnabled(enabled));
}

async function updateEditableSettings(patch: EditableSettingsPatch): Promise<void> {
  setSettings(await window.clipHistory.updateSettings(patch));
  await load();
}
```

主进程在处理 `sensitiveFilterEnabled:true->false` 的 `settings:update` 内调用
`runtime.reconcileAfterSettingsChange()`；不向 renderer 暴露 reconcile API。

- [ ] **Step 5: 实现 StartupPrompt 和状态优先级**

`StartupPrompt` 使用 `role="dialog" aria-modal="true"`，只有“启用后台记录”和“暂不启用”两个
明确命令；没有关闭 X。应用退出前未选择不会写决策版本。

```tsx
export function StartupPrompt({ onChoose }: { onChoose: (enabled: boolean) => void }) {
  return (
    <div className="startup-prompt-backdrop">
      <section className="startup-prompt" role="dialog" aria-modal="true" aria-labelledby="startup-title">
        <h2 id="startup-title">后台记录</h2>
        <div className="startup-prompt-actions">
          <button type="button" onClick={() => onChoose(false)}>暂不启用</button>
          <button type="button" className="primary" onClick={() => onChoose(true)}>启用后台记录</button>
        </div>
      </section>
    </div>
  );
}
```

设置页状态优先级固定：startup error > capture disabled > fallback/starting > listening。启动开关调用
专用 API；敏感过滤复用 `.switch-row`。状态行使用稳定高度，避免 1.5 秒轮询时布局跳动。

- [ ] **Step 6: 实现 IPC 与设置变化对账**

- `startup:getState` -> `startupManager.getState()`。
- `startup:setEnabled` -> `startupManager.setEnabled(Boolean(value))`。
- `background:getState` -> `runtime.getState()`。
- `settings:update` 只接受 `captureEnabled`、`maxItems`、`retentionDays`、`maxTextLength`、
  `maxImageBytes`、`hotkey`、`sensitiveFilterEnabled`；过滤从 true 变 false 后
  `runtime.reconcileAfterSettingsChange()`。

- [ ] **Step 7: 运行 GREEN、构建与提交**

```powershell
npx vitest run src/renderer/src/App.test.tsx src/main/lib/textFilter.test.ts src/main/lib/clipboardWatcher.test.ts
npm run build
git add src/shared/types.ts src/preload/index.ts src/renderer/src/global.d.ts src/renderer/src/useClipboardHistory.ts src/renderer/src/App.tsx src/renderer/src/StartupPrompt.tsx src/renderer/src/SettingsPane.tsx src/renderer/src/styles.css src/renderer/src/App.test.tsx src/main/index.ts
git commit -m "feat: surface background capture settings"
```

---

### Task 14: 打包原生助手、更新文档并加固 CI/Release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Modify: `scripts/afterPack.cjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Verify: `docs/superpowers/plans/2026-07-12-clipboard-capture-reliability.md`

- [ ] **Step 1: 先写 afterPack 缺失助手失败行为**

在现有 cleanup 结束前增加：

```js
const helperPath = path.join(appDir, 'resources', 'clipboard-listener.exe')
if (!fs.existsSync(helperPath)) {
  throw new Error(`[afterPack] Missing native clipboard helper: ${helperPath}`)
}

const probe = require('child_process').spawnSync(helperPath, ['--self-test'], {
  windowsHide: true,
  timeout: 5000,
  encoding: 'buffer'
})
if (probe.status !== 0) {
  throw new Error(`[afterPack] Clipboard helper self-test failed with status ${probe.status}`)
}
```

禁止把 probe stdout/stderr 原样写入构建日志。

- [ ] **Step 2: 先运行旧打包确认 RED**

清除旧忽略产物，避免陈旧 `release/resources/clipboard-listener.exe` 假通过：

```powershell
$workspace = (Resolve-Path .).Path
$releasePath = [IO.Path]::GetFullPath((Join-Path $workspace 'release'))
if ([IO.Path]::GetDirectoryName($releasePath) -ne $workspace) { throw 'Unsafe release path' }
Remove-Item -LiteralPath $releasePath -Recurse -Force -ErrorAction SilentlyContinue
npm run dist
```

Expected: 在 `extraResources` 接入前 FAIL，明确报告缺少助手。

- [ ] **Step 3: 固定 npm 生命周期与 extraResources**

`package.json` scripts 变为：

```json
"pretest": "npm run build:helper",
"test": "vitest run",
"test:watch": "vitest",
"build:helper": "node scripts/buildClipboardListener.cjs",
"test:helper": "node scripts/buildClipboardListener.cjs --tests && build\\clipboard-listener-tests.exe",
"build": "npm run build:helper && tsc --noEmit && electron-vite build",
"dist": "npm run build && electron-builder --win nsis"
```

`build.extraResources` 增加：

```json
[
  {
    "from": "build/clipboard-listener.exe",
    "to": "clipboard-listener.exe"
  }
]
```

- [ ] **Step 4: 验证旧计划替代标记并更新 README**

旧计划标题后增加明确说明：

```markdown
> **已被替代：** 本计划中的“助手只发送 sequence、Electron 再读剪贴板”无法保存高速中间态。
> 请执行 `2026-07-12-reliable-background-clipboard-capture.md`。
```

README 必须说明：登录静默启动、手动启动显示、助手故障自动轮询、敏感过滤默认关闭且可选、
近实时但非绝对零遗漏、`npm test/build/dist`、未签名 SmartScreen 风险。

- [ ] **Step 5: 加固 CI**

`ci.yml` 在 build 后增加：

```yaml
      - run: npm run dist
      - name: Verify packaged helper
        shell: pwsh
        run: |
          if (-not (Test-Path 'release/win-unpacked/resources/clipboard-listener.exe')) {
            throw 'Packaged clipboard-listener.exe is missing'
          }
          node scripts/verifyClipboardListener.cjs release/win-unpacked/resources/clipboard-listener.exe
      - uses: actions/upload-artifact@v4
        with:
          name: windows-installer-pr-${{ github.sha }}
          path: |
            release/*.exe
            release/*.blockmap
            release/latest.yml
```

- [ ] **Step 6: 加固 Release tag/version 一致性**

`release.yml` 在 `npm ci` 后增加：

```yaml
      - name: Verify tag matches package version
        shell: pwsh
        run: |
          $version = node -p "require('./package.json').version"
          if ('v' + $version -ne '${{ github.ref_name }}') {
            throw "Tag ${{ github.ref_name }} does not match package version $version"
          }
```

保留 test/build 和 `electron-builder --publish always`；发布前同样执行 helper 验证。

- [ ] **Step 7: 运行 GREEN 并提交构建/文档**

```powershell
npm test
npm run build
npm run dist
node scripts/verifyClipboardListener.cjs release/win-unpacked/resources/clipboard-listener.exe
git add package.json package-lock.json .gitignore scripts/afterPack.cjs .github/workflows/ci.yml .github/workflows/release.yml README.md
git commit -m "ci: validate Windows clipboard helper artifacts"
```

Expected: 0 failures；安装包、`.blockmap`、`latest.yml` 和 packaged helper 都存在。

---

### Task 15: 建立安全备份与本机端到端验收

**Files:**
- Create: `scripts/backupUserData.cjs`
- Create: `scripts/verifyClipboardCapture.cjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 写 backup 自测试模式**

`backupUserData.cjs --self-test` 在临时目录生成 allowed 与 disallowed 文件，断言只复制：

```text
settings.json
settings.json.bak
history.json
history.json.tmp
history.json.bak
vault.key
content/**
```

每个时间戳目录固定包含 `data/` 和 `manifest.json`；manifest 每项只有
`{path,bytes,sha256}`，路径相对 `data/`。自测试断言 source allowlist 与 `data/` 文件集及
SHA-256 完全一致，stdout 不出现任何文件内容。

- [ ] **Step 2: 写捕获验收脚本自测试**

`verifyClipboardCapture.cjs --self-test` 用临时 metadata 验证 hash 比对逻辑：

```js
function textHash(text) {
  return createHash('sha256').update('text').update('\0').update(text).digest('hex')
}
```

正式模式生成随机前缀、20 个唯一文本和一个重复文本；PowerShell STA 进程以 100ms 间隔调用
`[Windows.Forms.Clipboard]::SetText()`，结束时在内存中恢复原 IDataObject，任何日志都不打印原剪贴板。
脚本只读 `history.json` 的 hash/copyCount，禁止解密正文。

同一个 STA 验收进程还创建两张 2x2 的纯色 Bitmap，间隔 300ms 调用 `Clipboard.SetImage()`；
脚本比较写入前后 image metadata 数量至少增加 2，并通过应用 UI 检查两张缩略图。助手故障测试
只终止父 PID 为当前应用主进程、路径为 packaged resources helper 的进程，禁止按进程名批量结束。

- [ ] **Step 3: 运行脚本确认 RED/GREEN**

首次运行预期文件不存在而 RED；实现后：

```powershell
node scripts/backupUserData.cjs --self-test
node scripts/verifyClipboardCapture.cjs --self-test
```

Expected: 两个命令 exit 0，分别输出单行 `backup self-test: PASS`、`capture verifier self-test: PASS`。

- [ ] **Step 4: 接入 npm verify 命令并提交**

```json
"verify:helper": "node scripts/verifyClipboardListener.cjs build/clipboard-listener.exe",
"verify:capture": "node scripts/verifyClipboardCapture.cjs"
```

Run and commit:

```powershell
npm test
node scripts/backupUserData.cjs --self-test
node scripts/verifyClipboardCapture.cjs --self-test
git add scripts/backupUserData.cjs scripts/verifyClipboardCapture.cjs package.json package-lock.json
git commit -m "test: add safe local clipboard upgrade verification"
```

- [ ] **Step 5: 完成版本升级**

只有前 14 个任务全部 GREEN 后运行：

```powershell
npm version 0.1.1 --no-git-tag-version
npm test
npm run build
npm run dist
```

Expected: `package.json`、`package-lock.json` 为 `0.1.1`，没有创建 git tag；完整测试、构建和打包成功。

```powershell
git add package.json package-lock.json
git commit -m "chore: release 0.1.1"
```

- [ ] **Step 6: 从托盘正常退出当前 0.1.0**

先记录当前安装路径和进程，不输出剪贴板内容。通过托盘“退出”让旧进程正常结束，确认：

```powershell
Get-Process -Name '历史剪贴板' -ErrorAction SilentlyContinue
```

Expected: 无主进程。若旧残留 helper 存在，只终止确认属于旧安装路径的该进程。

- [ ] **Step 7: 备份当前用户数据**

```powershell
node scripts/backupUserData.cjs `
  --source "$env:APPDATA\history-clipboard" `
  --destination "$env:USERPROFILE\Documents\history-clipboard-backups"
```

Expected: 新建带时间戳且不覆盖旧备份的目录；source/backup 文件集、字节数和 SHA-256 全部一致；
命令输出只有目标目录、文件数和总字节数。

- [ ] **Step 8: 静默升级安装本机 0.1.1**

先定位本次新生成安装器，禁止使用旧 `release` 文件：

```powershell
$installer = Get-ChildItem release -Filter '*Setup 0.1.1.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait
```

安装后、首次启动前再次运行 backup verifier 的 compare 模式，确认 installer 没有改动 `%APPDATA%`。

- [ ] **Step 9: 验证迁移与启动体验**

首次普通启动必须显示旧用户提示；选择“启用后台记录”后验证：

- `settings.json` 为 `launchAtStartup=true`、`startupDecisionVersion=1`、`sensitiveFilterEnabled=false`。
- Windows login item path 指向当前安装 EXE、args 精确为 `--launch-at-login`、enabled=true。
- 以 `--launch-at-login` 启动时主窗口不显示；再次普通启动显示并聚焦已有窗口。
- 关闭窗口后托盘和捕获继续工作。

UI 操作使用真实安装应用，不直接手改 `settings.json`，否则迁移验收无效。

- [ ] **Step 10: 执行真实捕获和故障恢复验收**

```powershell
node scripts/verifyClipboardCapture.cjs --user-data "$env:APPDATA\history-clipboard"
```

Expected:

- 连续 3 轮、每轮 20 个 100ms 唯一文本全部对应 metadata hash。
- 相同文本重复复制不新增 item，但 copyCount 增加。
- 两张纯图片均增加 image item 且应用内缩略图可打开。
- 强制结束 helper 后 15 秒内状态变为轮询降级；期间 marker 被记录；helper 自动恢复为正常监听。
- 独立 STA 进程持有剪贴板锁超过 1 秒时出现 `clipboard-busy` gap；释放后最新 marker 被对账保存。
- 退出前最后一个 marker 在应用完全退出后仍存在于 metadata hash。
- 日志和临时目录扫描不到 marker 明文。

- [ ] **Step 11: 验证历史数据和密钥未丢失**

对比升级前 backup 清单与当前 `vault.key` hash；在应用 UI 随机打开升级前已有文本/图片记录，确认可读。
不在终端输出解密内容。若 key hash 变化或旧内容不可读，停止发布并恢复备份。

---

### Task 16: 推送 PR、合并并发布 GitHub v0.1.1

**Files:**
- Verify only: entire repository and GitHub state

- [ ] **Step 1: 完成本地发布前审计**

```powershell
git status --short
git diff origin/main...HEAD --check
npm test
npm run build
npm run dist
node scripts/verifyClipboardListener.cjs release/win-unpacked/resources/clipboard-listener.exe
```

Expected: 工作树干净；0 failures；计划要求文件全部存在；没有未跟踪密钥、备份或明文日志。

- [ ] **Step 2: 推送功能分支**

```powershell
git push -u origin fix/clipboard-capture-reliability
```

Expected: 远端分支指向当前本地 HEAD。

- [ ] **Step 3: 创建 PR 并等待 CI**

本机没有 `gh` CLI。使用已登录的 GitHub 浏览器打开：

```text
https://github.com/Jin-wen-jie/history-clipboard/compare/main...fix/clipboard-capture-reliability
```

PR 标题：`fix: make background clipboard capture resilient`

PR 正文必须包含：根因、原生快照/监督降级架构、启动迁移、敏感过滤默认值、测试/本机验收、
“无法恢复进程离线历史”的边界。等待 PR 的 Windows CI 和打包 artifact 全绿。

- [ ] **Step 4: 合并并验证 main**

使用 GitHub 的 squash 或 merge 按仓库现有策略合并。然后：

```powershell
git fetch origin main
git rev-parse origin/main
git show origin/main:package.json | Select-String '"version": "0.1.1"'
```

Expected: `origin/main` 是 PR 合并提交，版本为 0.1.1，main CI 成功。

- [ ] **Step 5: 只在 main 合并提交创建 tag**

```powershell
git tag -a v0.1.1 origin/main -m "Release v0.1.1"
git push origin v0.1.1
```

Expected: tag 精确指向 `origin/main`，触发 Release workflow。禁止在功能分支 HEAD 与 main 不一致时打 tag。

- [ ] **Step 6: 验证 GitHub Release**

等待 Release workflow 完成，核对：

- `/releases/latest` 指向 `v0.1.1`。
- Release 包含 NSIS 安装器、`.blockmap`、`latest.yml`。
- `latest.yml` 版本为 0.1.1，文件名和 sha512 对应上传安装器。
- 从 Release 下载的安装器包含 `resources/clipboard-listener.exe`，helper 自测试通过。
- GitHub 上功能分支、PR、main CI、tag 和 Release URL 都能核验。

- [ ] **Step 7: 最终完成审计**

逐条对照规格第 15 节成功标准，记录每项证据：测试输出、文件路径、Windows 状态、backup manifest、
PR/CI/Release URL。任何一项缺证据都不能报告完成。

---

## 规格覆盖索引

| 规格范围 | 实施任务 |
|---|---|
| 登录静默、手动显示、旧用户提示 | 10、11、13、15 |
| 原生快照与二进制协议 | 5、6、7 |
| 心跳、重启、轮询降级、缺口可见 | 8、9、12、13 |
| 相同内容重复复制与队列背压 | 8、9、15 |
| revision、tmp/bak、flush、孤儿清理 | 2、3、4、12 |
| 敏感过滤默认关闭且可见 | 10、13、15 |
| 正常退出排空 | 4、8、12、15 |
| 安全日志与无明文备份 | 2、7、9、14、15 |
| 打包、版本、本机升级 | 14、15 |
| PR、main、tag、GitHub Release | 16 |

## 计划执行方式

按用户“全部按照推荐要求执行”的授权，使用 **subagent-driven-development**：每个 Task 派一个新
实现 agent，主 agent 在每个任务后先做规格符合性审查，再做代码质量审查；只有两次审查通过才
进入下一任务。涉及同一文件的任务严格顺序执行，不并行写入共享文件。
