/**
 * D81 §3-D-1（评审 §3-D）：浏览器写入统一执行器。
 *
 * 同步开启的设备由一个执行器负责浏览器写入——同步引擎 tick/align 与镜像 ops 执行
 * 共享同一串行锁，杜绝两套机制并发搬动同一节点（回环/竞态病灶）。
 * 收纳盒保留独立业务流程（服务端映射/归位），但其浏览器执行动作（runMirrorOps）
 * 统一排队进本执行器。用户直接操作（右键收藏等）不排队——即时响应，引擎随后收敛。
 */
let chain: Promise<unknown> = Promise.resolve();

/** 串行执行浏览器写入任务；前序失败不阻塞后续（隔离），并发调用按到达顺序排队 */
export function withBrowserExecutor<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}