const { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const appExe = path.join(root, "src-tauri", "target", "release", "history-clipboard.exe");
const helperExe = path.join(root, "build", "clipboard-listener.exe");
const icon = path.join(root, "src-tauri", "icons", "icon.ico");
const outputDir = path.join(root, "release");
const output = path.join(outputDir, `历史剪贴板 Tauri Setup ${pkg.version}.exe`);

for (const required of [appExe, helperExe, icon]) {
  if (!existsSync(required)) throw new Error(`Installer input is missing: ${required}`);
}

function findMakensis() {
  if (process.env.NSIS_MAKENSIS && existsSync(process.env.NSIS_MAKENSIS)) {
    return process.env.NSIS_MAKENSIS;
  }
  const cache = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache");
  if (!existsSync(cache)) return undefined;
  for (const name of readdirSync(cache)) {
    if (!name.startsWith("nsis-")) continue;
    const versionDir = path.join(cache, name);
    for (const child of readdirSync(versionDir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const candidate = path.join(versionDir, child.name, "Bin", "makensis.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const makensis = findMakensis();
if (!makensis) {
  throw new Error("NSIS compiler not found. Set NSIS_MAKENSIS to makensis.exe.");
}

mkdirSync(outputDir, { recursive: true });
rmSync(output, { force: true });
const nsiPath = path.join(tmpdir(), `history-clipboard-${process.pid}.nsi`);
const q = (value) => value.replaceAll("$", "$$");
const script = `
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
Name "历史剪贴板"
OutFile "${q(output)}"
InstallDir "$LOCALAPPDATA\\Programs\\history-clipboard"
Icon "${q(icon)}"
UninstallIcon "${q(icon)}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

!include "MUI2.nsh"
!include "FileFunc.nsh"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\\历史剪贴板.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装" SEC_MAIN
  SetShellVarContext current
  $\{GetParameters\} $R0
  $\{GetOptions\} $R0 "/TESTMODE" $R1
  IfErrors normal_install test_install
normal_install:
  IfFileExists "$INSTDIR\\Uninstall 历史剪贴板.exe" 0 +2
    ExecWait '\"$INSTDIR\\Uninstall 历史剪贴板.exe\" /S'
  Goto install_files
test_install:
install_files:
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /oname=历史剪贴板.exe "${q(appExe)}"
  File /oname=clipboard-listener.exe "${q(helperExe)}"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  $\{GetOptions\} $R0 "/TESTMODE" $R1
  IfErrors install_shortcuts install_done
install_shortcuts:
  CreateShortcut "$DESKTOP\\历史剪贴板.lnk" "$INSTDIR\\历史剪贴板.exe" "" "$INSTDIR\\历史剪贴板.exe"
  CreateDirectory "$SMPROGRAMS\\历史剪贴板"
  CreateShortcut "$SMPROGRAMS\\历史剪贴板\\历史剪贴板.lnk" "$INSTDIR\\历史剪贴板.exe" "" "$INSTDIR\\历史剪贴板.exe"
  CreateShortcut "$SMPROGRAMS\\历史剪贴板\\卸载历史剪贴板.lnk" "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.local.historyclipboard" "DisplayName" "历史剪贴板"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.local.historyclipboard" "DisplayVersion" "${pkg.version}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.local.historyclipboard" "Publisher" "Jin-wen-jie"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.local.historyclipboard" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.local.historyclipboard" "UninstallString" '\"$INSTDIR\\Uninstall.exe\"'
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.local.historyclipboard" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.local.historyclipboard" "NoRepair" 1
install_done:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  nsExec::ExecToLog 'taskkill /F /IM "历史剪贴板.exe"'
  Delete "$DESKTOP\\历史剪贴板.lnk"
  RMDir /r "$SMPROGRAMS\\历史剪贴板"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.local.historyclipboard"
  Delete "$INSTDIR\\clipboard-listener.exe"
  Delete "$INSTDIR\\历史剪贴板.exe"
  Delete "$INSTDIR\\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
`;

try {
  writeFileSync(nsiPath, `\uFEFF${script}`, "utf8");
  const result = spawnSync(makensis, ["/V2", nsiPath], { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0 || !existsSync(output)) {
    throw result.error || new Error(`NSIS exited with code ${result.status}`);
  }
  console.log(`[tauri-installer] Created ${output}`);
} finally {
  rmSync(nsiPath, { force: true });
}
