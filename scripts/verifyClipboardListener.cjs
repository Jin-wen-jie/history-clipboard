const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { inflateSync } = require("node:zlib");

const READY_TIMEOUT_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 2000;
const SELF_TEST_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 3000;
const BACKPRESSURE_SHUTDOWN_TIMEOUT_MS = 4000;
const BACKPRESSURE_PING_COUNT = 30000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(message) {
  throw new Error(message);
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createFrameCollector(child, ClipboardAgentFrameParser) {
  const parser = new ClipboardAgentFrameParser();
  const frames = [];
  const waiters = [];
  let parseError;
  let streamFinished = false;

  function rejectWaiters(error) {
    while (waiters.length > 0) waiters.shift().reject(error);
  }

  function failParsing(message) {
    if (parseError) return;
    parseError = new Error(message);
    rejectWaiters(parseError);
  }

  function settleWaiters() {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      const frame = frames.find(waiter.predicate);
      if (frame) {
        waiters.splice(index, 1);
        waiter.resolve(frame);
      }
    }
  }

  child.stdout.on("data", (chunk) => {
    if (parseError) return;
    try {
      frames.push(...parser.push(chunk));
      settleWaiters();
    } catch {
      failParsing("helper stdout contained an invalid protocol frame");
    }
  });

  function finishParser() {
    if (streamFinished) return;
    streamFinished = true;
    try {
      parser.finish();
    } catch {
      failParsing("helper stdout ended with an incomplete protocol frame");
      return;
    }
    rejectWaiters(new Error("helper stdout ended before an expected protocol frame"));
  }

  child.stdout.once("end", finishParser);
  child.stdout.once("close", finishParser);

  function waitFor(predicate) {
    if (parseError) return Promise.reject(parseError);
    const frame = frames.find(predicate);
    if (frame) return Promise.resolve(frame);
    if (streamFinished) return Promise.reject(new Error("helper stdout ended before an expected protocol frame"));
    return new Promise((resolve, reject) => waiters.push({ predicate, resolve, reject }));
  }

  return { frames, waitFor, getParseError: () => parseError };
}

function spawnHelper(executable, args, ClipboardAgentFrameParser) {
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  const collector = createFrameCollector(child, ClipboardAgentFrameParser);
  const exit = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("helper process could not be started")));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const processExit = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("helper process could not be started")));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on("error", () => undefined);
  return { child, collector, exit, processExit, stderrChunks };
}

function assertReady(frame, child) {
  if (frame.version !== 1 || frame.type !== "ready") fail("helper did not emit a version 1 ready frame");
  if (!Number.isInteger(frame.pid) || frame.pid <= 0 || frame.pid !== child.pid) {
    fail("helper ready frame contained an invalid pid");
  }
}

function assertCleanExit(result, stderrChunks, collector, mode) {
  if (collector.getParseError()) throw collector.getParseError();
  if (result.code !== 0 || result.signal !== null) fail(`${mode} helper did not exit cleanly`);
  if (Buffer.concat(stderrChunks).length !== 0) fail(`${mode} helper wrote to stderr`);
}

async function stopChild(run) {
  if (run.child.exitCode === null && run.child.signalCode === null) {
    run.child.kill();
    run.child.stdout.destroy();
    try {
      await withTimeout(run.exit, 1000, "helper cleanup timed out");
    } catch {
      // Preserve the original verification failure without leaking child output.
    }
  }
}

async function verifyProduction(executable, ClipboardAgentFrameParser) {
  const run = spawnHelper(executable, [], ClipboardAgentFrameParser);
  try {
    const ready = await withTimeout(
      run.collector.waitFor((frame) => frame.type === "ready"),
      READY_TIMEOUT_MS,
      "production helper timed out before ready"
    );
    assertReady(ready, run.child);

    const heartbeatCount = run.collector.frames.filter((frame) => frame.type === "heartbeat").length;
    run.child.stdin.write("PING\n");
    await withTimeout(
      run.collector.waitFor((_frame, index) => {
        if (_frame.type !== "heartbeat") return false;
        return run.collector.frames.slice(0, index + 1).filter((frame) => frame.type === "heartbeat").length > heartbeatCount;
      }),
      HEARTBEAT_TIMEOUT_MS,
      "production helper timed out before heartbeat"
    );

    run.child.stdin.write("SHUTDOWN\n");
    const result = await withTimeout(
      run.exit,
      SHUTDOWN_TIMEOUT_MS,
      "production helper timed out during shutdown"
    );
    assertCleanExit(result, run.stderrChunks, run.collector, "production");
  } finally {
    await stopChild(run);
  }
}

async function verifyEof(executable, ClipboardAgentFrameParser) {
  const run = spawnHelper(executable, [], ClipboardAgentFrameParser);
  try {
    const ready = await withTimeout(
      run.collector.waitFor((frame) => frame.type === "ready"),
      READY_TIMEOUT_MS,
      "EOF helper timed out before ready"
    );
    assertReady(ready, run.child);
    run.child.stdin.end();
    const result = await withTimeout(
      run.exit,
      SHUTDOWN_TIMEOUT_MS,
      "EOF helper timed out during shutdown"
    );
    assertCleanExit(result, run.stderrChunks, run.collector, "EOF");
  } finally {
    await stopChild(run);
  }
}

async function verifyBackpressure(executable, ClipboardAgentFrameParser) {
  const run = spawnHelper(executable, [], ClipboardAgentFrameParser);
  try {
    const ready = await withTimeout(
      run.collector.waitFor((frame) => frame.type === "ready"),
      READY_TIMEOUT_MS,
      "backpressure helper timed out before ready"
    );
    assertReady(ready, run.child);

    run.child.stdout.pause();
    // The Electron supervisor always resumes the helper's stdout before
    // sending SHUTDOWN (clipboardAgentSupervisor.stop() calls resumeStdout),
    // so mirror that here. A paused pipe can never be drained, and force-
    // closing it mid-frame truncates the protocol stream — the helper cannot
    // satisfy "clean EOF" unless the reader keeps consuming.
    run.child.stdin.write("PING\n".repeat(BACKPRESSURE_PING_COUNT));
    run.child.stdout.resume();
    run.child.stdin.write("SHUTDOWN\n");
    const processResult = await withTimeout(
      run.processExit,
      BACKPRESSURE_SHUTDOWN_TIMEOUT_MS,
      "backpressure helper timed out during shutdown"
    );
    run.child.stdout.destroy();
    const closeResult = await withTimeout(
      run.exit,
      1000,
      "backpressure helper pipes did not close"
    );
    if (processResult.code !== closeResult.code || processResult.signal !== closeResult.signal) {
      fail("backpressure helper exit state was inconsistent");
    }
    assertCleanExit(closeResult, run.stderrChunks, run.collector, "backpressure");
  } finally {
    await stopChild(run);
  }
}

function validatePngChunks(png) {
  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawEnd = false;
  const compressedParts = [];

  while (offset < png.length) {
    if (png.length - offset < 12) fail("self-test snapshot PNG contained a truncated chunk");
    const dataLength = png.readUInt32BE(offset);
    const chunkEnd = offset + 12 + dataLength;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > png.length) {
      fail("self-test snapshot PNG chunk exceeded its boundary");
    }

    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + dataLength);
    if (!sawHeader) {
      if (type !== "IHDR" || dataLength !== 13) {
        fail("self-test snapshot PNG did not start with IHDR");
      }
      sawHeader = true;
    } else if (type === "IHDR") {
      fail("self-test snapshot PNG contained multiple IHDR chunks");
    }

    if (type === "IDAT") compressedParts.push(data);
    if (type === "IEND") {
      if (dataLength !== 0 || chunkEnd !== png.length) {
        fail("self-test snapshot PNG IEND boundary was invalid");
      }
      sawEnd = true;
    }
    offset = chunkEnd;
  }

  if (!sawHeader || compressedParts.length === 0 || !sawEnd || offset !== png.length) {
    fail("self-test snapshot PNG chunk sequence was incomplete");
  }
  try {
    if (inflateSync(Buffer.concat(compressedParts)).length === 0) {
      fail("self-test snapshot PNG decompressed to empty data");
    }
  } catch {
    fail("self-test snapshot PNG IDAT could not be decompressed");
  }
}

function assertSelfTestSnapshot(snapshot) {
  if (snapshot.text !== "self-test") fail("self-test snapshot text did not match");
  if (!Buffer.isBuffer(snapshot.png) || snapshot.png.length < 24) {
    fail("self-test snapshot did not contain a valid PNG");
  }
  if (!snapshot.png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    fail("self-test snapshot did not contain a valid PNG signature");
  }
  if (snapshot.png.toString("ascii", 12, 16) !== "IHDR") {
    fail("self-test snapshot did not contain a PNG IHDR");
  }
  if (
    snapshot.width !== 1 ||
    snapshot.height !== 1 ||
    snapshot.png.readUInt32BE(16) !== 1 ||
    snapshot.png.readUInt32BE(20) !== 1
  ) {
    fail("self-test snapshot PNG dimensions were not 1x1");
  }
  validatePngChunks(snapshot.png);
}

async function verifySelfTest(executable, ClipboardAgentFrameParser) {
  const run = spawnHelper(executable, ["--self-test"], ClipboardAgentFrameParser);
  try {
    const ready = await withTimeout(
      run.collector.waitFor((frame) => frame.type === "ready"),
      SELF_TEST_TIMEOUT_MS,
      "self-test helper timed out before ready"
    );
    assertReady(ready, run.child);
    const snapshot = await withTimeout(
      run.collector.waitFor((frame) => frame.type === "snapshot"),
      SELF_TEST_TIMEOUT_MS,
      "self-test helper timed out before snapshot"
    );
    assertSelfTestSnapshot(snapshot);
    const result = await withTimeout(
      run.exit,
      SELF_TEST_TIMEOUT_MS,
      "self-test helper did not exit automatically"
    );
    assertCleanExit(result, run.stderrChunks, run.collector, "self-test");
  } finally {
    await stopChild(run);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const selfTestOnly = args.includes("--self-test");
  const positional = args.filter((arg) => arg !== "--self-test");
  if (positional.length !== 1) fail("usage: node scripts/verifyClipboardListener.cjs [--self-test] <helper.exe>");

  const executable = path.resolve(positional[0]);
  if (!existsSync(executable)) fail("helper executable not found");

  const parserUrl = pathToFileURL(
    path.resolve(__dirname, "..", "src", "main", "lib", "clipboardAgentProtocol.ts")
  ).href;
  const { ClipboardAgentFrameParser } = await import(parserUrl);

  if (!selfTestOnly) {
    await verifyProduction(executable, ClipboardAgentFrameParser);
    await verifyEof(executable, ClipboardAgentFrameParser);
    await verifyBackpressure(executable, ClipboardAgentFrameParser);
  }
  await verifySelfTest(executable, ClipboardAgentFrameParser);
  process.stdout.write(`clipboard-listener verify: PASS (${selfTestOnly ? "self-test" : "production+self-test+EOF+backpressure"})\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "verification failed";
  process.stderr.write(`clipboard-listener verify: FAIL ${message}\n`);
  process.exitCode = 1;
});
