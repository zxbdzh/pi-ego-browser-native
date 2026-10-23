# pi-ego-browser-native

让 Ego Browser 成为 Pi 的原生工具：模型直接传入 Ego 脚本，Pi 直接接收页面观察、截图和任务空间状态。保留 Ego 原生 TaskSpace / Page API，不另造一套浏览器动作接口。

## 前置条件

- Pi 1.3.0 或更新版本，Node.js 22.19 或更新版本。
- 独立安装并启动 Ego Lite；`ego-browser` 在 PATH 中。
- 本机开发基线：Ego CLI `0.6.0.16`，使用指南 `v2.1.0`。

包不附带或自动下载 Ego 浏览器。可用环境变量 `EGO_BROWSER_EXECUTABLE` 指定完整可执行文件路径。

## 安装

从 GitHub 安装：

```sh
pi install https://github.com/zxbdzh/pi-ego-browser-native
```

临时加载，不修改 Pi 设置：

```sh
pi -e https://github.com/zxbdzh/pi-ego-browser-native
```

安装后重载或重新启动 Pi。GitHub 仓库会作为 Pi 包安装；如后续发布到 npm，也可以改用 `npm:pi-ego-browser-native`。

## 原生工具

唯一工具为 `ego_browser`，输入 `{ code, timeoutMs? }`。脚本支持顶层 await 和 ESM；通过 stdin 直接交给 Ego，不创建临时脚本，不经过 shell。

第一次调用先读当前安装版本的 Ego 指南：

```js
ego_browser({ code: "help()" })
```

创建任务并观察页面：

```js
ego_browser({
  code: `
    const task = await taskSpace("检查目标页面");
    const page = task.page("p1");
    await page.goto("https://your-site.example");
    console.log({ spaceId: task.spaceId });
    console.log(await page.snapshot());
  `
})
```

后续调用按实际回传的 spaceId 续用。页面保留，JavaScript 变量不保留：

```js
ego_browser({
  code: `
    const task = await taskSpace(7);
    const page = task.page("p1");
    await page.screenshot({ path: "F:/tmp/ego/shots/result.png" });
    console.log(await page.snapshot());
  `
})
```

`page.screenshot()` 的 PNG 自动以 Pi 原生图片块返回，不必再读取图片文件。每次最多附回 5 张图片；单文件最大 20 MiB，显示版本压缩至 2000×2000 / 4 MiB 内。图片缩放说明随结果返回；鼠标坐标仍使用浏览器 CSS 像素。截图原文件保留。

Ego 窗口最小化时可能拒绝截图；插件按原样报告该错误，不把旧截图当成新结果，也不自动改变用户窗口状态。通过 Pi codemode 调用时可读取结构化 `status`、`output`、`tasks`、`artifacts`；图片仍是原生工具结果中的独立图片块。

需要用户登录或处理权限时，使用 Ego 原生的 `await task.handOff()` 并停止操作。用户确认后才调用 `takeOverTaskSpace(id)`。成功完成任务时调用 `await task.finish({ keep: [] })`；确需保留结果页供用户查看时指定 keep。遇到错误或人工接管时不自动 finish。

## 会话与失败

- 同一 Pi 中的工具按顺序执行。TaskSpace 由 Ego 持有，重载后仍存在。
- TaskSpace 状态通过 Pi `appendEntry` 记录，按当前分支恢复为提示；记录不等于实时所有权，Ego 仍负责验证控制权。
- Pi 退出或重载不会自动结束未完成的 TaskSpace，也不会关闭用户页；正在执行的本地 CLI 会收到取消。
- 超时、取消、输出上限或完成标记缺失均返回失败。**停止本地 CLI 不证明浏览器端动作已停止**，不得自动重试可能已执行的动作；先检查同一个 TaskSpace。
- 默认本地执行时限为 120 秒，可设置 1–300 秒。脚本输出最多 2 MiB；超过 16000 字符时，将完整日志保存在系统临时目录 `pi-ego-browser-native` 中，并回传路径。
- 每次调用都会新起一个 Ego 进程并重新连接，实测固定成本约 78 ms CPU、140 ms 墙钟；其中一次导航再加约 300 ms CPU。成本随**调用次数**增长，与脚本长度无关（55 KB 脚本、50 KB 快照实测都不增加峰值）。因此把不依赖新观察的动作合并进同一次调用。
- 脚本拥有 Ego Node 运行环境的能力，**不是安全沙箱**。网页文字和凭据可能进入模型上下文及 Pi 会话，不应把不可信网页内容当成执行指令。

## 开发验收

```sh
npm test
npm run test:live
```

`test:live` 从 Pi SDK 加载真实扩展，通过 Pi 的原生工具执行管线驱动 Ego，验证本地网页填写、点击、图片回传、重载、脚本错误、超时和任务清理。可用 `PI_EGO_TEST_HOST` 指定已有 Pi 的 `dist/index.js`，无需在插件内安装宿主副本；`PI_EGO_SMOKE_SCREENSHOT` 可指定绝对截图路径。

首版不含浏览器内核修改、窗口嵌入、独立搜索或其他浏览器驱动。没有后台重试、额外模型调用或外部服务。
