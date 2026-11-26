# Codex Prompt Assistant

Windows 官方 Codex 桌面版的本地提示词增强与翻译工具，支持选区处理及撤销；使用 Ollama 和 qwen3.5:4b，不适用于 Code-Codex。

## 安装

本仓库不包含 Node 可执行文件。下载源码后，将 Node.js 24 Windows x64 官方发行版中的 node.exe 放到 runtime/node.exe。从 [Ollama 官网下载并安装 Ollama](https://ollama.com/download)，然后执行 `ollama pull qwen3.5:4b`（需数 GB 空间），双击 Install.cmd。然后从开始菜单打开 **Codex Prompt Assistant → Start Codex with Prompt Assistant**。若 Codex 已在运行且没有按钮，请先完全退出，再使用此入口启动。

选中文字可增强选区或通过格式工具栏翻译；成功后可撤销。开始菜单的 **Check Prompt Assistant** 可检查 Codex、后台进程、Ollama 和模型状态；开始菜单提供卸载入口，不删除 Codex 对话或 Ollama 模型。

## 工作原理与限制

这不是官方插件：通过监听 127.0.0.1 的 Chromium 调试接口注入按钮。本机其他进程可能通过接口读取或控制 Codex 页面，请仅在信任本机软件的环境使用。增强和翻译发送至本机 Ollama；涉及上下文时可能发送少量对话内容。Codex 更新可能导致不兼容。

44 项源码测试及临时目录安装、卸载已通过；全新电脑首次冷启动尚未验证。源码位于 src/，Node 许可证见 runtime/NODE-LICENSE.txt。
