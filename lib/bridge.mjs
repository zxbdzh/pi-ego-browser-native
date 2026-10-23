// 只包装回传点，不翻译 Ego 的定位器、动作或错误语义。
function installBridge(prefix) {
  const write = console.log.bind(console);
  const send = (event) => write(prefix + JSON.stringify(event));
  const pageCache = new WeakMap();
  const taskCache = new WeakMap();
  const rawPages = new WeakMap();
  const wrapPage = (page) => {
    if (!page || typeof page !== "object") return page;
    if (pageCache.has(page)) return pageCache.get(page);
    const proxy = new Proxy(page, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "screenshot") return async (...args) => {
          const file = await value.apply(target, args);
          send({ type: "image", path: file, spaceId: target.spaceId, page: target.label });
          return file;
        };
        if (key === "waitForEvent") return async (...args) => {
          const result = await value.apply(target, args);
          return args[0] === "popup" ? wrapPage(result) : result;
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    pageCache.set(page, proxy);
    rawPages.set(proxy, page);
    return proxy;
  };
  const wrapTask = (task) => {
    if (taskCache.has(task)) return taskCache.get(task);
    const state = (status) => send({ type: "task", spaceId: task.spaceId, name: task.name, ownership: task.ownership, status });
    state("active");
    const proxy = new Proxy(task, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "page" || key === "userPage") return (...args) => wrapPage(value.apply(target, args));
        if (key === "newPage" || key === "adopt") return async (...args) => wrapPage(await value.apply(target, args.map(arg => rawPages.get(arg) ?? arg)));
        if (key === "pages" || key === "tabs") return async (...args) => (await value.apply(target, args)).map((item) => item?.page ? { ...item, page: wrapPage(item.page) } : wrapPage(item));
        if (key === "finish" || key === "handOff") return async (...args) => {
          const result = await value.apply(target, args);
          state(key === "finish" ? "finished" : "handed-off");
          return result;
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    taskCache.set(task, proxy);
    return proxy;
  };
  for (const key of ["taskSpace", "takeOverTaskSpace", "claimTaskSpace"]) {
    const original = globalThis[key];
    if (typeof original === "function") globalThis[key] = async (...args) => wrapTask(await original(...args));
  }
  return send;
}

export function buildScript(code, token) {
  const module = `data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`;
  return `const __piSend = (${installBridge.toString()})(${JSON.stringify(token)});\ntry {\n  await import(${JSON.stringify(module)});\n  __piSend({ type: "complete" });\n} catch (error) {\n  __piSend({ type: "error", name: String(error?.name ?? "Error"), message: String(error?.message ?? error), code: error?.code, executionStopped: error?.executionStopped, mayHaveLateEffects: error?.mayHaveLateEffects });\n  process.exitCode = 1;\n}\n`;
}

export function readEvent(line, token) {
  if (!line.startsWith(token)) return undefined;
  const event = JSON.parse(line.slice(token.length));
  if (!event || !["task", "image", "complete", "error"].includes(event.type)) throw new Error("无效的 Ego 桥接消息。");
  return event;
}

export function restoreTasks(branch) {
  const tasks = new Map();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== "pi-ego-tasks") continue;
    for (const task of entry.data?.tasks ?? []) {
      if (!Number.isSafeInteger(task.spaceId) || task.spaceId < 1) continue;
      if (task.status === "finished") tasks.delete(task.spaceId);
      else tasks.set(task.spaceId, task);
    }
  }
  return [...tasks.values()];
}
