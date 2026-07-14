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

## 上传到 GitHub

```bash
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

## 说明

第一版不记录文件剪贴板、不做图片 OCR、不做云同步。窗口关闭后仍会在托盘后台记录；图片超过 10MB 不保存。
