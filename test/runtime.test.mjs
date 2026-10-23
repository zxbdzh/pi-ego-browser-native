import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildScript, readEvent, restoreTasks } from "../lib/bridge.mjs";
import { runProcess } from "../lib/process.mjs";

const token = "__TEST_BRIDGE__";
test("原生 TaskSpace/Page API 保持调用语义，截图和接管产生结构化事件", async () => {
  const events = [];
  const page = { spaceId: 7, label: "p1", screenshot: async () => "F:/shot.png", snapshot() { return this.label; } };
  const task = { spaceId: 7, name: "中文任务", ownership: "agent", page: () => page, pages: async () => [page], tabs: async () => [{page, label: "p1"}], adopt: async (p) => { assert.equal(p, page); return p; }, handOff: async () => {}, finish: async () => {} };
  const context = vm.createContext({ console: { log: (line) => events.push(readEvent(line, token)) }, taskSpace: async () => task });
  const bridgeSource = buildScript("", token).split("\ntry {")[0];
  vm.runInContext(bridgeSource, context);
  await vm.runInContext('(async () => { const t = await taskSpace(7); const p = t.page("p1"); if(p.snapshot() !== "p1") throw Error("this lost"); await p.screenshot(); await (await t.adopt((await t.tabs())[0].page)).screenshot(); await (await t.pages())[0].screenshot(); await t.handOff(); await t.finish({keep: []}); })()', context);
  assert.deepEqual(events.map(e => e.type === "task" ? e.status : e.type), ["active", "image", "image", "image", "handed-off", "finished"]);
  assert.equal(events[1].path, "F:/shot.png");
});

test("普通页面日志不能误作桥接回执；脚本源码不会被 shell 解释", () => {
  assert.equal(readEvent('{"type":"image","path":"secret"}', token), undefined);
  assert.throws(() => readEvent(token + "{}", token));
  const code = 'console.log("中文 $() ` \\\" \\n");';
  const source = buildScript(code, token);
  assert.ok(source.includes(Buffer.from(code).toString("base64")));
});

test("仅恢复当前分支的任务记录，finish 删除活跃记录", () => {
  const record = tasks => ({type: "custom", customType: "pi-ego-tasks", data: {tasks}});
  assert.deepEqual(restoreTasks([record([{spaceId: 1, status: "active"}]), record([{spaceId: 1, status: "finished"}, {spaceId: 2, status: "handed-off"}])]), [{spaceId: 2, status: "handed-off"}]);
});

test("stdin 原样传递中文/引号，分块输出不破坏 UTF-8", async () => {
  const result = await runProcess(process.execPath, ["-e", 'process.stdin.on("data", d=>process.stdout.write(d));'], {input: '中文 "quotes"\n$() `literal`'});
  assert.equal(result.status, "ok");
  assert.equal(result.stdout, '中文 "quotes"\n$() `literal`');
  const split = await runProcess(process.execPath, ["-e", 'const b=Buffer.from("中文"); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),30);']);
  assert.equal(split.stdout, "中文");
  const lines = [];
  const diagnostic = await runProcess(process.execPath, ["-e", 'console.error("中文回执");'], {onLine: line => lines.push(line)});
  assert.equal(diagnostic.status, "ok");
  assert.deepEqual(lines, ["中文回执"]);
});

test("CLI 退出后不被继承 stdout 的后台进程拖住", async () => {
  const code = 'const {spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e","setTimeout(()=>{}, 1200)"],{stdio:["ignore",process.stdout,process.stderr],detached:true}); c.unref(); console.log("done");';
  const started = Date.now();
  const result = await runProcess(process.execPath, ["-e", code], {timeoutMs: 5000});
  assert.equal(result.status, "ok");
  assert.ok(result.stdout.includes("done"));
  assert.ok(Date.now() - started < 1100, "必须以 CLI 的退出为准");
});

test("取消前不派发，超时和输出上限必须返回失败状态", async () => {
  const controller = new AbortController(); controller.abort();
  const aborted = await runProcess(process.execPath, ["-e", 'throw Error("must not run")'], {signal: controller.signal});
  assert.equal(aborted.status, "aborted"); assert.equal(aborted.dispatched, false);
  const active = new AbortController();
  const started = Date.now();
  const operation = runProcess(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {signal: active.signal, timeoutMs: 10000});
  setTimeout(() => active.abort(), 100);
  const stopped = await operation;
  assert.equal(stopped.status, "aborted"); assert.equal(stopped.dispatched, true);
  assert.ok(Date.now() - started < 5000, "取消不能等完整超时才返回");
  const timed = await runProcess(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {timeoutMs: 80});
  assert.equal(timed.status, "timeout");
  const large = await runProcess(process.execPath, ["-e", 'console.log("x".repeat(10000))'], {maxBytes: 100});
  assert.equal(large.status, "output-limit");
});
