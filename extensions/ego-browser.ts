import { randomBytes } from "node:crypto";
import { open, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Type } from "@earendil-works/pi-ai";
import { resizeImage, formatDimensionNote, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findExecutable, runProcess } from "../lib/process.mjs";
import { buildScript, readEvent, restoreTasks } from "../lib/bridge.mjs";

export default function egoBrowser(pi: ExtensionAPI) {
  let guide: string | undefined;
  const running = new Set<AbortController>();

  pi.on("before_agent_start", (event, ctx) => {
    if (!pi.getActiveTools().includes("ego_browser")) return;
    const tasks = restoreTasks(ctx.sessionManager.getBranch());
    event.systemPromptOptions.sections.ego_browser = [
      "Use ego_browser for browser work. Scripts execute in Ego's own Node ESM runtime, not in Pi or the web page.",
      guide ?? "First call ego_browser with code: 'help()' to load the installed Ego guide before browser actions.",
      "The tool automatically loads the matching Ego guide and attaches screenshots taken through TaskSpace Page handles. No shell commands or temporary script files are needed.",
      "Use exactly one TaskSpace for a user goal; print and reuse its numeric spaceId. JS variables do not survive calls. Use absolute file paths; shell cwd/env are not available inside Ego.",
      "Respect user control and native Ego errors. After handOff(), stop until the user confirms. Never automatically claim a user-owned space. Finish successful tasks with task.finish({keep: []}); do not finish after errors or handoff.",
      "A timeout/abort stops the local CLI, but does not prove that dispatched browser actions stopped. Inspect the SAME space before further changes; never replay an uncertain mutation.",
      "A screenshot is automatically attached to Pi when page.screenshot() resolves; coordinates are CSS pixels and Pi may resize the image. The script has Node capabilities: this tool is not a sandbox.",
      // 每次调用都要新起一个 Ego 进程并重新连接（实测约 78 ms CPU / 140 ms 墙钟），导航另加约 300 ms；
      // 反复小步调用是最主要的卡顿来源，因此显式要求合并动作，而不是按文本长度限制脚本。
      "Each call starts a fresh Ego process and reconnects (measurably ~78 ms CPU and ~140 ms before the script even runs; navigation adds ~300 ms). Cost scales with the number of calls, not with script length: batch every action that does not depend on a fresh observation into one call, and end that call with the single observation you need next.",
      tasks.length ? `TaskSpace records from the active Pi branch (historical hints only; verify live ownership before acting): ${JSON.stringify(tasks)}` : "No TaskSpace recorded on the active Pi branch.",
    ].join("\n\n");
  });

  pi.on("session_shutdown", () => {
    for (const controller of running) controller.abort();
    // 退出或重载只停本地调用；不擅自关闭浏览器中的用户标签或结束未完成任务。
  });

  pi.registerTool({
    name: "ego_browser",
    label: "Ego Browser",
    description: "Operate the user's Ego Browser with its native TaskSpace/Page JavaScript API: open pages, inspect snapshots, click, fill, extract data, take screenshots, and hand control to the user. Preserves TaskSpaces across calls and returns screenshots inline. First call code: 'help()' to receive the installed API guide. Not a sandbox.",
    promptSnippet: "Run native Ego Browser scripts; return page observations, inline screenshots, and TaskSpace state.",
    executionMode: "sequential",
    outputSchema: Type.Object({
      status: Type.String(),
      output: Type.String(),
      tasks: Type.Array(Type.Object({ spaceId: Type.Integer(), name: Type.String(), status: Type.String() }, { additionalProperties: true })),
      artifacts: Type.Array(Type.Object({ path: Type.String(), verified: Type.Boolean() }, { additionalProperties: true })),
      mayHaveLateEffects: Type.Boolean(),
      error: Type.Optional(Type.String()),
    }, { additionalProperties: true }),
    parameters: Type.Object({
      code: Type.String({ minLength: 1, maxLength: 65536, description: "Ego Node ESM script with top-level await. Use native taskSpace()/Page APIs and console.log() for output." }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000, description: "Local execution deadline in milliseconds; default 120000. Timeout does not prove browser actions were cancelled." })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      running.add(controller);
      const tasks = new Map<number, any>();
      const images: any[] = [];
      const artifacts: any[] = [];
      let scriptError: any, completed = false, result: any;
      let output = "", guideForModel = "";
      const content: any[] = [];
      try {
        const executable = await findExecutable();
        if (!guide) {
          const probe = await runProcess(executable, ["skill"], { signal: controller.signal, timeoutMs: 15000 });
          if (probe.status !== "ok" || !probe.stdout.includes("[ego-browser:skill] end of guide")) {
            throw new Error(`无法加载完整 Ego 使用指南。${probe.error ?? probe.stderr ?? probe.status}`);
          }
          guide = probe.stdout;
          guideForModel = `Installed Ego guide (read before your next browser action):\n${guide}\n\n`;
        }
        const token = `__PI_EGO_${randomBytes(16).toString("hex")}__`;
        result = await runProcess(executable, ["nodejs"], {
          input: buildScript(params.code, token), signal: controller.signal, timeoutMs: params.timeoutMs,
          onLine(line: string) {
            const event = readEvent(line, token);
            if (!event) { output += line + "\n"; return; }
            if (event.type === "task" && Number.isSafeInteger(event.spaceId)) {
              tasks.set(event.spaceId, event);
              onUpdate?.({ content: [{ type: "text", text: `Ego TaskSpace ${event.spaceId}: ${event.status}` }], details: { tasks: [...tasks.values()] } });
            } else if (event.type === "image") images.push(event);
            else if (event.type === "error") scriptError = event;
            else if (event.type === "complete") completed = true;
          },
        });
        if (scriptError || !completed) {
          if (result.status === "ok") result.status = "error";
          result.error ??= scriptError?.message ?? "Ego 未返回脚本完成标记；不得假设动作已完成。";
        }
        // 只读取实际回执中的截图；不从普通日志里猜路径，避免把任意输出当图片证据。
        for (const image of images.slice(0, 5)) {
          const artifact: any = { path: image.path, spaceId: image.spaceId, page: image.page, verified: false };
          artifacts.push(artifact);
          let file;
          try {
            if (typeof image.path !== "string" || !path.isAbsolute(image.path)) throw new Error("截图路径不是绝对路径。");
            file = await open(image.path, "r");
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error("截图不是普通文件或超过 20 MiB。");
            const bytes = await file.readFile();
            if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Ego 截图不是有效 PNG。");
            const resized = await resizeImage(bytes, "image/png", { maxWidth: 2000, maxHeight: 2000, maxBytes: 4 * 1024 * 1024 });
            if (!resized) throw new Error("截图无法压缩到 Pi 图片限制。");
            Object.assign(artifact, { verified: true, width: resized.originalWidth, height: resized.originalHeight });
            content.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
            const note = formatDimensionNote(resized);
            if (note) content.push({ type: "text", text: note });
          } catch (error) {
            artifact.error = (error as Error).message;
            result.status = "error";
          } finally { await file?.close(); }
        }
        if (images.length > 5) output += `\nOnly the first 5 screenshots are attached; ${images.length - 5} additional screenshots remain at their saved paths.\n`;
        if (output.length > 16000) {
          const directory = path.join(os.tmpdir(), "pi-ego-browser-native");
          await mkdir(directory, { recursive: true });
          const fullOutputPath = path.join(directory, `${randomBytes(12).toString("hex")}.log`);
          await writeFile(fullOutputPath, output, { mode: 0o600 });
          output = output.slice(0, 10000) + `\n[Output truncated; full output: ${fullOutputPath}]\n` + output.slice(-4000);
          result.fullOutputPath = fullOutputPath;
        }
      } catch (error) {
        result = { ...result, status: controller.signal.aborted ? "aborted" : "error", error: (error as Error).message };
      } finally {
        signal?.removeEventListener("abort", abort);
        running.delete(controller);
        if (tasks.size) pi.appendEntry("pi-ego-tasks", { tasks: [...tasks.values()] });
      }
      const uncertain = (!completed && !scriptError || ["timeout", "aborted", "output-limit", "bridge-error"].includes(result.status)) && result.dispatched;
      const details = {
        status: result.status, tasks: [...tasks.values()], artifacts,
        error: result.error, scriptError, exitCode: result.exitCode,
        fullOutputPath: result.fullOutputPath,
        executionStopped: scriptError?.executionStopped,
        mayHaveLateEffects: scriptError?.mayHaveLateEffects ?? Boolean(uncertain),
      };
      const text = guideForModel + JSON.stringify(details) + "\n" + output + (uncertain ? "\nExecution outcome is uncertain. Inspect the same TaskSpace before any further mutation; do not retry the script." : "");
      return { content: [{ type: "text", text }, ...content], details, structuredContent: { ...details, output: text }, isError: result.status !== "ok" };
    },
  });
}
