/**
 * D67 多形态租户内核：自建（NAS 单容器单用户）与云端（多用户）同一套代码。
 *
 * 核心机制 = 「请求上下文 + 数据库解析器」：
 *  - 鉴权中间件解析令牌后以 runAsUser 建立用户上下文（AsyncLocalStorage）；
 *  - Store 持有数据库解析器，this.db 每次访问时按上下文取数据文件；
 *  - 自建形态 userId 恒为 self → 恒解析主库（行为与历史版本逐字节一致）；
 *  - 云端形态每用户一个 SQLite 文件（DATA_DIR/users/<id>/my-favorites.db），
 *    注册即建库跑迁移——隔离靠构造（文件边界），不改写仓储层任何一条 SQL。
 * 跨用户共享面（users/令牌/部署设置/认证审计/公开 slug）集中在 registry.ts（主库）。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { openDb, type Db } from "./db";

/** 自建形态唯一 owner（主库即数据文件；users 表中无对应行，令牌 user_id 回填此值） */
export const SELF_USER_ID = "self";

const als = new AsyncLocalStorage<{ userId: string }>();

/** 同步 apply 期间的设备标记上下文（D67：替代 Store 单例可变字段——多用户下全局字段会跨用户污染变更日志的防回环标记） */
const deviceAls = new AsyncLocalStorage<{ device: string }>();

export function runAsSyncDevice<T>(device: string, fn: () => T): T {
  return deviceAls.run({ device }, fn);
}

export function currentSyncDevice(): string | null {
  return deviceAls.getStore()?.device ?? null;
}

/** 以指定用户身份执行 fn（期间 Store.db / currentUserId 均解析到该用户） */
export function runAsUser<T>(userId: string, fn: () => T): T {
  return als.run({ userId }, fn);
}

/** 当前请求上下文的用户；无上下文（公开路由/后台/构建期）= self = 主库 */
export function currentUserId(): string {
  return als.getStore()?.userId ?? SELF_USER_ID;
}

/** 后台任务遍历口径：自建单用户，云端逐用户库执行（调用方负责 fn 内用 Store） */
export function forEachUser(userIds: string[], fn: (userId: string) => void): void {
  for (const userId of userIds) {
    runAsUser(userId, () => fn(userId));
  }
}

/**
 * 用户数据文件管理器（D67 连接池）：懒打开 + 容量上限 + 空闲回收。
 *
 * 容量口径（回答「1000 个用户怎么办」）：磁盘上 1000 个用户文件毫无压力（每文件仅数 MB），
 * 稀缺资源是**打开的连接句柄**——每连接占 1 组 fd（db+wal+shm）与最高 ~2MB 页缓存。
 * 本池保证「打开句柄数 ≈ 最近活跃用户数」而非「注册用户数」：
 *  - 上限兜底 maxOpen（默认 256）：突发扫描超过上限时回收最久未用（fd 兜底）；
 *  - 空闲回收 idleMs（默认 10 分钟）：sweepIdle 关闭闲置连接，startReaper 每分钟一扫；
 *  - 安全性靠「Store.db 每次访问重新解析」的构造——无跨 await 的句柄缓存
 *   （唯一本地捕获 publishNavSite 在纯同步事务内，定时器无法插入同步段），
 *   句柄被回收后下一次 store 方法调用会透明重开（重跑迁移仅一条 SELECT 水位检查）。
 * 注册用户规模天花板由此不在 SQLite，而在磁盘与运营；单机活跃数百级再往上走 PostgreSQL（D15 既定）。
 */
export class UserDbManager {
  private cache = new Map<string, { db: Db; lastUsed: number }>();

  constructor(
    private dataDir: string,
    private mainDb: Db,
    /** 打开句柄上限兜底（fd 保护）；仅突发远超时逐出，稳态由 idleMs 决定 */
    private maxOpen = 256,
    /** 空闲回收阈值 */
    private idleMs = 10 * 60_000,
  ) {}

  dbFor(userId: string): Db {
    // D68 统一：owner（'self'）恒主库（既有单文件部署数据不动）；其余用户各自数据文件
    if (userId === SELF_USER_ID) return this.mainDb;
    const hit = this.cache.get(userId);
    if (hit) {
      hit.lastUsed = Date.now();
      // 刷新 LRU 位次（Map 迭代序 = 插入序，删了重插即移尾）
      this.cache.delete(userId);
      this.cache.set(userId, hit);
      return hit.db;
    }
    while (this.cache.size >= this.maxOpen) this.evictOldest();
    // 注册即建库：openDb 内含迁移（用户库 schema 与主库同版）；被回收重开时仅水位检查
    const db = openDb(`${this.dataDir}/users/${userId}`);
    this.cache.set(userId, { db, lastUsed: Date.now() });
    return db;
  }

  /** 逐出最久未用的连接（Map 首 = lastUsed 最小） */
  private evictOldest(): void {
    const oldest = this.cache.keys().next().value;
    if (oldest === undefined) return;
    const entry = this.cache.get(oldest)!;
    try {
      entry.db.close();
    } catch {
      /* 已关闭/并发关闭：忽略 */
    }
    this.cache.delete(oldest);
  }

  /** 关闭闲置连接；当前请求上下文正在用的库跳过（重入安全） */
  sweepIdle(now = Date.now()): number {
    const current = currentUserId();
    let closed = 0;
    for (const [uid, entry] of [...this.cache]) {
      if (uid === current) continue;
      if (now - entry.lastUsed >= this.idleMs) {
        try {
          entry.db.close();
        } catch {
          /* 同上 */
        }
        this.cache.delete(uid);
        closed++;
      }
    }
    return closed;
  }

  /** 常驻每分钟一扫（unref：不阻止进程退出） */
  startReaper(): void {
    const t = setInterval(() => this.sweepIdle(), 60_000);
    if (typeof t.unref === "function") t.unref();
  }

  /** 当前打开的连接数（诊断/测试） */
  get openCount(): number {
    return this.cache.size;
  }

  /** 停机兜底（测试/优雅退出用） */
  closeAll(): void {
    for (const entry of this.cache.values()) {
      try {
        entry.db.close();
      } catch {
        /* 同上 */
      }
    }
    this.cache.clear();
  }
}
