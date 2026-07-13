const { existsSync, mkdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const windir = process.env.WINDIR || "C:\\Windows";
const compilerCandidates = [
  path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
];
const compiler = compilerCandidates.find((candidate) => existsSync(candidate));

if (!compiler) {
  console.error("clipboard-listener build: .NET Framework v4.0.30319 C# compiler not found");
  process.exit(1);
}

const tests = process.argv.slice(2).includes("--tests");
const buildDirectory = path.join(root, "build");
mkdirSync(buildDirectory, { recursive: true });

const coreSources = [
  path.join(root, "native", "clipboard-listener", "AgentProtocol.cs"),
  path.join(root, "native", "clipboard-listener", "ClipboardFrameQueue.cs"),
  path.join(root, "native", "clipboard-listener", "CaptureSequenceTracker.cs")
];
const productionSources = coreSources.concat([
  path.join(root, "native", "clipboard-listener", "NativeMethods.cs"),
  path.join(root, "native", "clipboard-listener", "ClipboardSnapshotReader.cs"),
  path.join(root, "native", "clipboard-listener", "ClipboardListenerWindow.cs"),
  path.join(root, "native", "clipboard-listener", "Program.cs")
]);
const output = tests
  ? path.join("build", "clipboard-listener-tests.exe")
  : path.join("build", "clipboard-listener.exe");
const sources = tests
  ? coreSources.concat(path.join(root, "native", "clipboard-listener-tests", "Program.cs"))
  : productionSources;

const args = [
  "/nologo",
  "/langversion:5",
  "/target:exe",
  `/out:${output}`,
  "/reference:System.dll",
  "/reference:System.Core.dll",
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Web.Extensions.dll"
].concat(sources);

const result = spawnSync(compiler, args, {
  cwd: root,
  stdio: "inherit",
  windowsHide: true
});

if (result.error || result.status !== 0) {
  process.exit(typeof result.status === "number" && result.status !== 0 ? result.status : 1);
}
