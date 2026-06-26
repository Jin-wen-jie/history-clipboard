// afterPack hook for electron-builder
// Removes unnecessary Electron files to reduce installer size
exports.default = async function (context) {
  const fs = require('fs')
  const path = require('path')

  const resourcesPath = path.join(context.appOutDir, 'resources')
  if (!fs.existsSync(resourcesPath)) return

  // 1. Remove unnecessary locales (keep only zh-CN and en-US)
  const localesDir = path.join(context.appOutDir, 'locales')
  if (fs.existsSync(localesDir)) {
    const files = fs.readdirSync(localesDir)
    const keepLocales = new Set(['zh-CN.pak', 'en-US.pak', 'en-GB.pak'])
    for (const file of files) {
      if (!keepLocales.has(file) && file.endsWith('.pak')) {
        const filePath = path.join(localesDir, file)
        fs.unlinkSync(filePath)
      }
    }
    console.log(`[afterPack] Removed ${files.length - 3} locale files`)
  }

  // 2. Remove LICENSES.chromium.html (huge legal file)
  const appDir = context.appOutDir
  const chromiumLicense = path.join(appDir, 'LICENSES.chromium.html')
  if (fs.existsSync(chromiumLicense)) {
    const size = fs.statSync(chromiumLicense).size
    fs.unlinkSync(chromiumLicense)
    console.log(`[afterPack] Removed LICENSES.chromium.html (${(size / 1024 / 1024).toFixed(1)}MB)`)
  }

  // 3. Remove snapshot_blob.bin and v8_context_snapshot.bin are needed, keep them

  console.log('[afterPack] Cleanup complete')
}
