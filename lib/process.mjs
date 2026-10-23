import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export async function findExecutable(env = process.env) {
  if (env.EGO_BROWSER_EXECUTABLE) return env.EGO_BROWSER_EXECUTABLE;
  const directories = (env.PATH ?? env.Path ?? "").split(path.delimiter);
  for (const directory of directories) {
    const candidate = path.join(directory, process.platform === "win32" ? "ego-browser.exe" : "ego-browser");
    try { await access(candidate); return candidate; } catch { /* PATH 中可能含已删除的目录，继续找同名可执行文件。 */ }
  }
  throw new Error("未找到 ego-browser；请先安装 Ego Lite，并将 ego-browser 加入 PATH。");
}

export async function runProcess(executable, args, { input = "", signal, timeoutMs = 120_000, onLine, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (signal?.aborted) return { status: "aborted", stdout: "", stderr: "", dispatched: false };
  return await new Promise((resolve) => {
    let stdout = "", stderr = "", pending = "", stderrPending = "", bytes = 0, reason, settled = false;
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
    let timer, reapTimer, exitTimer;
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    const stop = (status) => {
      if (reason || settled) return;
      reason = status;
      // Ego 的 Node 轮次在浏览器侧运行：杀 CLI 不能证明已撤销页面动作，结果必须保留“不确定”。
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else child.kill("SIGKILL");
      reapTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null); }, 3000);
      reapTimer.unref();
    };
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(reapTimer);
      clearTimeout(exitTimer);
      signal?.removeEventListener("abort", abort);
      const stdoutTail = stdoutDecoder.end();
      stdout += stdoutTail; pending += stdoutTail; const stderrTail = stderrDecoder.end(); stderr += stderrTail; stderrPending += stderrTail;
      if (pending) { try { onLine?.(pending); } catch (e) { error ??= e; } }
      if (stderrPending) { try { onLine?.(stderrPending); } catch (e) { error ??= e; } }
      resolve({ status: reason ?? (error || exitCode !== 0 ? "error" : "ok"), exitCode, stdout, stderr, dispatched: Boolean(child.pid), error: error?.message });
    };
    const abort = () => stop("aborted");
    child.stdout.on("data", (chunk) => {
      if (reason || settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) return stop("output-limit");
      const text = stdoutDecoder.write(chunk);
      stdout += text; pending += text;
      let index;
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index).replace(/\r$/, "");
        pending = pending.slice(index + 1);
        try { onLine?.(line); } catch { stop("bridge-error"); break; }
      }
    });
    child.stderr.on("data", (chunk) => {
      if (reason || settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) return stop("output-limit");
      const text = stderrDecoder.write(chunk);
      stderr += text; stderrPending += text;
      let index;
      while ((index = stderrPending.indexOf("\n")) !== -1) {
        const line = stderrPending.slice(0, index).replace(/\r$/, "");
        stderrPending = stderrPending.slice(index + 1);
        try { onLine?.(line); } catch { stop("bridge-error"); break; }
      }
    });
    child.stdin.on("error", () => {}); // 提前退出时 EPIPE 由进程结果统一报告。
    child.on("error", (error) => finish(null, error));
    child.on("exit", (code) => {
      // 子进程可能把管道继承给后台程序；CLI 已退出后只留短暂时间排空输出。
      exitTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code); }, 250);
      exitTimer.unref();
    });
    child.on("close", (code) => finish(code));
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.end(input, "utf8");
  });
}
