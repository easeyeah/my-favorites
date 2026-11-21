/**
 * D50 变更事件进程内广播（管理台/服务端动作 → 扩展秒级收敛的推送通道）。
 *
 * 单实例自建形态无需消息中间件：Store.onRecorded → ChangeHub → 各 SSE 连接。
 * 语义只是「有事发生，来拉」——不携带数据本体（数据真相仍是 changes 表 + 游标增量），
 * 因此丢事件不丢正确性，兜底 = 扩展 1 分钟告警。
 */
export interface ChangeEvent {
  entity: string;
  entity_id: string;
  op: string;
  device: string | null;
}

export class ChangeHub {
  private listeners = new Set<(ev: ChangeEvent) => void>();

  subscribe(fn: (ev: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(ev: ChangeEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(ev);
      } catch {
        /* 单订阅者异常隔离 */
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
