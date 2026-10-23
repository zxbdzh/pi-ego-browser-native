import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// 开发验收可指向现有 Pi，不在插件包内复制一套宿主依赖。
const require = createRequire(import.meta.url);
const hostPath = process.env.PI_EGO_TEST_HOST ?? require.resolve("@earendil-works/pi-coding-agent");
const { DefaultResourceLoader, createAgentSession, SessionManager, SettingsManager } = await import(pathToFileURL(hostPath).href);
const root = fileURLToPath(new URL("../", import.meta.url));
const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-ego-smoke-"));
const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [root], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const sessionManager = SessionManager.create(root, path.join(agentDir, "sessions"));
// SDK 验收不调用模型；写入一条助手消息以触发 Pi 原生 JSONL 的实际持久化。
sessionManager.appendMessage({ role: "assistant", content: [{type: "text", text: "Ego 原生工具验收开始"}], api: "openai-responses", provider: "openai", model: "smoke-fixture", usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, stopReason: "stop", timestamp: Date.now() });
const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager, tools: ["ego_browser"], thinkingLevel: "off" });
await session.bindExtensions({ mode: "json" });
assert.ok(session.getActiveToolNames().includes("ego_browser"), JSON.stringify({active: session.getActiveToolNames(), loaded: loader.getExtensions().extensions.map(e => ({path: e.path, tools: [...e.tools.keys()]}))}));

const server = createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Ego × Pi 原生验收</title><style>body{font:20px system-ui;margin:64px;background:#f7f7f5;color:#222}main{max-width:640px}input,button{font:inherit;padding:12px;margin:8px 0}button{background:#175b3c;color:white;border:0}output{display:block;padding:24px 0;font-weight:bold}</style><main><h1>Ego × Pi 原生验收</h1><label for="name">任务名称</label><br><input id="name" value=""><br><button onclick="document.querySelector('output').textContent='已完成：'+document.querySelector('input').value;document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">验证原生调用</button><output>等待操作</output></main></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const screenshot = process.env.PI_EGO_SMOKE_SCREENSHOT ?? path.join(os.tmpdir(), "ego-shots", `pi-native-${Date.now()}.png`);
const results = [];
const call = async (code, timeoutMs, signal) => {
  const ctx = session.extensionRunner.createToolContext(`smoke-${results.length}`, undefined);
  const outcome = await ctx.executeTool("ego_browser", { code, ...(timeoutMs ? {timeoutMs} : {}) }, { signal });
  const result = { ...outcome.result, isError: outcome.isError };
  results.push(result);
  console.log(JSON.stringify({ step: results.length, ...result.details, images: result.content.filter(x => x.type === "image").length }));
  return result;
};
let spaceId;
try {
  const first = await call(`const task = await taskSpace(${JSON.stringify(`Pi Ego 原生验收 ${Date.now()}`)}); const page = task.page("p1"); await page.goto(${JSON.stringify(url)}); console.log(await page.snapshot());`);
  assert.equal(first.isError, false, JSON.stringify(first.details ?? first));
  spaceId = first.details.tasks[0].spaceId;
  const second = await call(`const task = await taskSpace(${spaceId}); const page = task.page("p1"); await page.fill("#name", "中文脚本 ✓"); await page.click("button"); await page.waitForFunction(() => document.querySelector("output").textContent === "已完成：中文脚本 ✓"); const window = await task.cdp("Browser.getWindowForTarget", {targetId: page.targetId}); await task.cdp("Browser.setWindowBounds", {windowId: window.windowId, bounds: {windowState: "normal"}}); await page.screenshot({path: ${JSON.stringify(screenshot.replaceAll("\\", "/"))}}); console.log(await page.snapshot());`);
  assert.equal(second.isError, false, JSON.stringify(second.details));
  assert.equal(second.content.filter(x => x.type === "image").length, 1);
  assert.equal(second.details.artifacts[0].verified, true);
  assert.equal(second.structuredContent.status, "ok");
  assert.equal(second.structuredContent.artifacts[0].verified, true);
  assert.ok(second.content[0].text.includes("已完成：中文脚本 ✓"));

  await session.reload();
  const afterReload = await call(`const task = await taskSpace(${spaceId}); const page = task.page("p1"); console.log({url: await page.url(), value: await page.evaluate(() => document.querySelector("output").textContent)});`);
  assert.equal(afterReload.isError, false);
  assert.ok(afterReload.content[0].text.includes("已完成：中文脚本 ✓"));
  const instructions = await session.extensionRunner.emitBeforeAgentStart({messageType: "user", prompt: "继续同一个浏览器任务"}, {cwd: root, selectedTools: ["ego_browser"]});
  assert.ok(instructions.systemPromptOptions.sections.ego_browser.includes(`"spaceId":${spaceId}`));

  const failed = await call(`const task = await taskSpace(${spaceId}); throw new Error("验收：故意失败，不应重放点击");`);
  assert.equal(failed.isError, true);
  assert.ok(failed.details.error.includes("故意失败"));
  const timed = await call(`const task = await taskSpace(${spaceId}); await task.page("p1").waitForSelector("#never-exists", {timeout: 10000});`, 1000);
  assert.equal(timed.isError, true);
  assert.equal(timed.details.status, "timeout");
  assert.equal(timed.details.mayHaveLateEffects, true);
  const cancellation = new AbortController();
  const pending = call(`const task = await taskSpace(${spaceId}); await task.page("p1").waitForSelector("#abort-check", {timeout: 10000});`, 15000, cancellation.signal);
  const cancelTimer = setTimeout(() => cancellation.abort(), 1200);
  const cancelled = await pending;
  clearTimeout(cancelTimer);
  assert.equal(cancelled.isError, true);
  assert.equal(cancelled.details.status, "aborted");
  assert.equal(cancelled.details.mayHaveLateEffects, true);
  const inspect = await call(`const task = await taskSpace(${spaceId}); const page = task.page("p1"); console.log({clicks: await page.evaluate(() => document.body.dataset.clicks)});`);
  assert.equal(inspect.isError, false);
  assert.ok(inspect.content[0].text.includes("'1'") || inspect.content[0].text.includes('"1"'));

  const finished = await call(`const task = await taskSpace(${spaceId}); await task.finish({keep: []});`);
  assert.equal(finished.isError, false);
  assert.equal(finished.details.tasks[0].status, "finished");
  const finalInstructions = await session.extensionRunner.emitBeforeAgentStart({messageType: "user", prompt: "任务已完成"}, {cwd: root, selectedTools: ["ego_browser"]});
  assert.ok(!finalInstructions.systemPromptOptions.sections.ego_browser.includes(`"spaceId":${spaceId}`));
  spaceId = undefined;
  await mkdir(path.join(root, ".artifacts"), {recursive: true});
  await writeFile(path.join(root, ".artifacts/live-smoke.json"), JSON.stringify({ passed: true, url, screenshot, sessionFile: sessionManager.getSessionFile(), steps: results.map(r => r.details) }, null, 2));
  console.log(`PASS: Pi 原生工具、真实网页填写/点击、截图、重载续用、失败、超时和清理。截图：${screenshot}`);
} finally {
  if (spaceId) {
    try { await call(`const task = await taskSpace(${spaceId}); await task.finish({keep: []});`); } catch {}
  }
  await session.extensionRunner.emit({type: "session_shutdown", reason: "quit"});
  session.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
