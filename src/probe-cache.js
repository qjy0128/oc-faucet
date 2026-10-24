/**
 * 体检判定缓存。
 *
 * 为什么要有它：给一批模型做体检要真的发消息、等模型回话，一次几十秒。同一批模型
 * 每次启动都重测一遍，用户会以为程序卡死。所以把「这个模型能不能按协议产生工具调用」
 * 的结论存到磁盘上，下次直接用。
 *
 * 三条硬要求：
 *  1. 结论必须带「指纹」（PROBE_FINGERPRINT）。提示词或判定规则改了，指纹就变，
 *     旧结论立刻作废——不能让改版后的旧结果继续骗人。
 *  2. 能用的结论（tool）可以放久一点；不能用的结论（chat）要短命，因为上游可能修好，
 *     短 TTL 让它有机会被重新测出来。
 *  3. 写盘必须原子（先写 .tmp 再 rename），并且同一进程里的并发写要排队，
 *     否则多个体检任务同时写会把文件写成半截 JSON。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BridgeError } from './errors.js';

/** 缓存文件结构版本。字段形状变了就 +1，旧文件会被当成空缓存丢掉，不会误读。 */
const CACHE_VERSION = 1;

export class ProbeCache {
  /** @type {string|null} 缓存文件绝对路径；为空表示只放内存不落盘 */
  #file;
  /** @type {number} 能用的结论存活多久 */
  #ttlMs;
  /** @type {number} 不能用的结论存活多久（要短，好让模型有机会被重测） */
  #failureTtlMs;
  /** @type {Map<string, {fingerprint:string, verdict:string, note:string, checkedAt:number}>} */
  #entries = new Map();
  /** 串行化写盘：每个写操作都挂在这条 Promise 链后面，保证不会互相踩 */
  #writeChain = Promise.resolve();

  /**
   * @param {object} o
   * @param {string} o.file 缓存文件路径（JSON）
   * @param {number} [o.ttlMs] 能用的结论 TTL，默认 6 小时
   * @param {number} [o.failureTtlMs] 不能用的结论 TTL，默认 10 分钟
   */
  constructor({ file, ttlMs = 6 * 3600 * 1000, failureTtlMs = 10 * 60 * 1000 } = {}) {
    this.#file = typeof file === 'string' && file ? file : null;
    this.#ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : 6 * 3600 * 1000;
    this.#failureTtlMs = Number.isFinite(failureTtlMs) && failureTtlMs >= 0 ? failureTtlMs : 10 * 60 * 1000;
  }

  /**
   * 从磁盘读回缓存。文件不存在、内容坏了、版本对不上，一律当成空缓存，**不抛错**——
   * 缓存坏掉最多让体检重跑一遍，绝不该让程序起不来。
   */
  async load() {
    // 先等正在进行的写盘结束，免得把刚写进磁盘的结论又读成旧内容
    await this.#writeChain;
    this.#entries = new Map();
    if (!this.#file) return;

    let raw;
    try {
      raw = await readFile(this.#file, 'utf8');
    } catch {
      return; // 文件不存在 / 读不了：当空缓存
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 坏 JSON：当空缓存
    }

    if (!parsed || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION) return;
    const entries = parsed.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return;

    for (const [modelId, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.fingerprint !== 'string') continue;
      if (entry.verdict !== 'tool' && entry.verdict !== 'chat' && entry.verdict !== 'failed') continue;
      if (!Number.isFinite(entry.checkedAt)) continue;
      this.#entries.set(modelId, {
        fingerprint: entry.fingerprint,
        verdict: entry.verdict,
        note: typeof entry.note === 'string' ? entry.note : '',
        checkedAt: entry.checkedAt,
      });
    }
  }

  /**
   * 取判定。指纹不同、过期、没记录，都是 null（= 需要重新体检）。
   * @param {string} modelId
   * @param {string} fingerprint
   * @returns {{verdict:'tool'|'chat'|'failed', checkedAt:number, note:string}|null}
   */
  get(modelId, fingerprint) {
    const entry = this.#entries.get(modelId);
    if (!entry) return null;
    if (entry.fingerprint !== fingerprint) return null;

    // tool = 判定能用，走长 TTL；chat / failed = 判定不能用或此刻不可用，走短 TTL
    //（免费池几分钟一换，失败多半是"此刻路由不到"，短 TTL 给它翻案的机会）
    const ttl = entry.verdict === 'tool' ? this.#ttlMs : this.#failureTtlMs;
    const age = Date.now() - entry.checkedAt;
    if (!Number.isFinite(age) || age < 0 || age > ttl) return null;

    return { verdict: entry.verdict, checkedAt: entry.checkedAt, note: entry.note };
  }

  /**
   * 写入判定并落盘。并发调用会自动排队，不会互相覆盖。
   * @param {string} modelId
   * @param {string} fingerprint
   * @param {'tool'|'chat'} verdict
   * @param {string} note
   */
  async set(modelId, fingerprint, verdict, note) {
    if (typeof modelId !== 'string' || !modelId) {
      throw new BridgeError('体检缓存写入失败：模型 id 不能为空', 500, 'probe_cache_invalid');
    }
    if (typeof fingerprint !== 'string' || !fingerprint) {
      throw new BridgeError('体检缓存写入失败：指纹不能为空', 500, 'probe_cache_invalid');
    }
    return this.#serialize(() => this.#writeEntry(modelId, fingerprint, verdict, String(note ?? '')));
  }

  /** 清空缓存（内存 + 磁盘文件内容） */
  async clear() {
    return this.#serialize(async () => {
      this.#entries = new Map();
      await this.#flush();
    });
  }

  /** 当前内存里的记录条数 */
  get size() {
    return this.#entries.size;
  }

  /** 给 JSON.stringify 用的纯数据形状 */
  toJSON() {
    const entries = {};
    for (const [modelId, entry] of this.#entries) entries[modelId] = { ...entry };
    return { version: CACHE_VERSION, entries };
  }

  /** 真正写一条记录：先改内存，再整份写盘 */
  async #writeEntry(modelId, fingerprint, verdict, note) {
    this.#entries.set(modelId, { fingerprint, verdict, note, checkedAt: Date.now() });
    await this.#flush();
  }

  /** 原子写：先写同目录的 .tmp，再 rename 覆盖目标文件（rename 在同一文件系统上是原子的） */
  async #flush() {
    if (!this.#file) return; // 没给文件路径就只放内存
    await mkdir(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.toJSON(), null, 2)}\n`, 'utf8');
    await rename(tmp, this.#file);
  }

  /**
   * 把任务挂到写链条队尾。链条上任何一环失败都不许把后面的写卡死，
   * 所以内部记录的链用一个「吞掉错误」的分支。
   */
  #serialize(task) {
    const result = this.#writeChain.then(task);
    this.#writeChain = result.then(() => undefined, () => undefined);
    return result;
  }
}
