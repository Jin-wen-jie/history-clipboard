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
- 谨慎隐私策略：过滤疑似验证码、密码、密钥和超长文本
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

## 上传到 GitHub

```bash
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

## 说明

第一版不记录文件剪贴板、不做图片 OCR、不做云同步。图片超过 10MB 不保存。
