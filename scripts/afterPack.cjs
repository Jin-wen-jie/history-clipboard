// afterPack hook for electron-builder.
// Removes unnecessary Electron files and validates the packaged helper.
exports.default = async function (context) {
  const fs = require('fs')
  const path = require('path')
  const { spawnSync } = require('child_process')

  const appDir = context.appOutDir

  // 1. Remove unnecessary locales (keep only zh-CN and en-US)
  const localesDir = path.join(appDir, 'locales')
  if (fs.existsSync(localesDir)) {
    const files = fs.readdirSync(localesDir)
    const keepLocales = new Set(['zh-CN.pak', 'en-US.pak', 'en-GB.pak'])
    for (const file of files) {
      if (!keepLocales.has(file) && file.endsWith('.pak')) {
        fs.unlinkSync(path.join(localesDir, file))
      }
    }
    console.log(`[afterPack] Removed ${files.length - 3} locale files`)
  }

  // 2. Remove LICENSES.chromium.html (19MB legal blob that compresses poorly)
  const chromiumLicense = path.join(appDir, 'LICENSES.chromium.html')
  if (fs.existsSync(chromiumLicense)) {
    const size = fs.statSync(chromiumLicense).size
    fs.unlinkSync(chromiumLicense)
    console.log(`[afterPack] Removed LICENSES.chromium.html (${(size / 1024 / 1024).toFixed(1)}MB)`)
  }

  const helper = path.join(appDir, 'resources', 'clipboard-listener.exe')
  if (!fs.existsSync(helper)) {
    throw new Error('[afterPack] Packaged clipboard helper is missing')
  }
  const selfTest = spawnSync(helper, ['--self-test'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  if (selfTest.error || selfTest.status !== 0) {
    throw new Error('[afterPack] Packaged clipboard helper self-test failed')
  }

  console.log('[afterPack] Cleanup complete')
}
