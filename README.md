# 历史剪贴板

一个本地 Windows 剪贴板历史工具，支持文本和图片记录。内容只保存在本机，文本和图片原始内容会加密落盘。

## 下载

[点击下载 Windows 安装包](https://github.com/Jin-wen-jie/history-clipboard/releases/latest)

## 功能

- 自动记录纯文本剪贴板历史
- 自动记录位图图片剪贴板历史，并生成缩略图
- 文本搜索、类型筛选、按时间范围查找、复制回剪贴板
- 置顶、删除、清空当前筛选
- 托盘常驻和 `Ctrl+Alt+V` 全局热键
- 首次启动可选择开机自启；启用后会在 Windows 登录时静默开始记录，手动打开时显示主窗口
- 监听组件异常时自动切换到降级轮询，避免因后台组件重启而长时间漏记
- 敏感内容过滤默认关闭，可在设置中开启以过滤疑似验证码、密码、密钥和超长文本
- 默认只保留最近 30 天内的最多 500 条记录

## 开发

```bash
npm install
npm run dev
```

## 验证

```bash
npm test
npm run build
```

## 打包 Windows 安装包

```bash
npm run dist
```

安装包会输出到 `release/`。

安装包尚未进行代码签名，首次下载运行时 Windows SmartScreen 可能会提示风险。请仅从本仓库的 Release 页面下载，并在确认发布来源后继续安装。

## 发布新版本与自动更新（差量更新）

已安装的电脑会在启动时和每小时自动检查更新。发现新版本后，客户端通过 blockmap 差分只下载与上一版不同的字节块（通常只有几 MB），退出应用时静默安装，下次打开即为新版本——全程无需手动下载安装包。托盘菜单和设置面板里也可以手动「检查更新」并查看下载进度。

发布流程（改完源码后只需两步）：

```bash
npm version 0.1.10      # 修改 package.json 版本号、自动提交并打 tag
npm test && npm run build
git push --follow-tags  # 推送代码和 tag
```

推送 tag 后 GitHub Actions（`.github/workflows/release.yml`）会自动构建、创建 Release 并上传安装包 + blockmap + latest.yml，各台电脑随即自动更新。

注意：

- 必须用 NSIS 安装包装过（`npm run dist` 生成的安装包）。直接运行 `release\win-unpacked\` 里的 exe 或 `npm run dev` 不会参与自动更新。
- 差量下载依赖本机缓存的上一版安装包（位于 `%LOCALAPPDATA%\history-clipboard-updater`），某台电脑首次更新时会下载完整包，之后都是几 MB 的差分。

## 上传到 GitHub

```bash
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

## 说明

第一版不记录文件剪贴板、不做图片 OCR、不做云同步。窗口关闭后仍会在托盘后台记录；图片超过 10MB 不保存。
