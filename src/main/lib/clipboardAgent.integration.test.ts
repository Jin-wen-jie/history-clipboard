import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ClipboardAgentFrameParser,
  type AgentFrame,
  type NativeClipboardSnapshot
} from "./clipboardAgentProtocol";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("integration timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      }
    );
  });
}

describe.runIf(process.platform === "win32")("ClipboardAgentSupervisor integration", () => {
  test("runs the real helper self-test without reading the clipboard", async () => {
    const helperPath = resolve("build", "clipboard-listener.exe");
    const args = ["--self-test"];
    const child = spawn(helperPath, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const parser = new ClipboardAgentFrameParser();
    const frames: AgentFrame[] = [];
    let stderrSeen = false;
    child.stdout.on("data", (chunk: Buffer) => {
      frames.push(...parser.push(Buffer.from(chunk)));
    });
    child.stderr.on("data", () => {
      stderrSeen = true;
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        try {
          parser.finish();
          done({ code, signal });
        } catch (error) {
          reject(error);
        }
      });
    });

    try {
      const exit = await withTimeout(exited, 10_000);
      const ready = frames.find((frame) => frame.type === "ready");
      const snapshot = frames.find(
        (frame): frame is NativeClipboardSnapshot => frame.type === "snapshot"
      );

      expect(args).toEqual(["--self-test"]);
      expect(exit).toEqual({ code: 0, signal: null });
      expect(stderrSeen).toBe(false);
      expect(ready).toMatchObject({ type: "ready", sequence: 0 });
      expect(snapshot).toBeDefined();
      if (!snapshot) throw new Error("self-test snapshot missing");
      expect(snapshot).toMatchObject({
        type: "snapshot",
        text: "self-test",
        width: 1,
        height: 1
      });
      expect(snapshot.png?.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }, 20_000);
});
