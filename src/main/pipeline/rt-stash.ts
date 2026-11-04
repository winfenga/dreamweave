/**
 * rt 快照存储（T6-G ① · parse 拿不到输入侧推导数据的工程解）。
 *
 * 【问题】T6-F ① 给 `parse(content, rt?)` 开了可选第二参 `rt`，但 `rt` 上只有
 * chunkIndex/chunkText/chunkChapters 等**同步字段**——而 parse 需要的是「输入侧
 * 推导数据」：如 characterAppearance 每人 `characterSpriteInfos` 的 chunkIndex 对照表
 * （sourceIndexes 解析的依据）、lineAnnotation 的合法 appearanceId 集合与各章行数。
 * 这些数据是 inputText/buildMessages 阶段读上游**现算**的；parse 是同步函数、禁止
 * 异步 IO（T6-F ① 纪律），不能再读一次上游。
 *
 * 【约束与依据（醒目，任何改动前必读）】
 *  1. **必须在 buildMessages 里 stash，在 inputText 里 stash 无效**：orchestrator 每个
 *     实例会新建**两个** rt——`rt0` 只调 `adapter.inputText(rt0)`（orchestrator.ts:383），
 *     `rt` 调 buildMessages 与 parse（orchestrator.ts:402/407/424）。buildMessages 与
 *     parse **共享同一 rt 实例**，故快照必须挂在该实例上；挂到 rt0 上 parse 永远读不到。
 *  2. **WeakMap 语义**：以 rt 对象为键——不阻 GC、无跨实例泄漏（实例结束即可回收），
 *     不同 rt 键互不串味（快照按实例隔离）。
 *  3. **parse 内只能读快照，不得异步 IO**：`readRtSnapshot` 是同步函数；需要读上游
 *     的组装一律在 inputText/buildMessages 完成（与 T6-F ① 同一纪律）。
 *
 * 用法：buildMessages 里 `stashRtSnapshot(rt, data)`；parse 里 `readRtSnapshot<T>(rt)`
 * （rt 缺失或未 stash → undefined，调用方按缺省值降级，不抛崩）。
 */

/** rt 实例 → 输入侧快照（弱引用：实例可回收，无泄漏）。 */
const RT_SNAPSHOTS = new WeakMap<object, unknown>()

/** 把输入侧推导数据挂到 rt 实例上（**buildMessages 阶段调用**；约束依据见文件头第 1 条）。 */
export function stashRtSnapshot(rt: object, data: unknown): void {
  RT_SNAPSHOTS.set(rt, data)
}

/** 读 rt 实例上的快照（parse 阶段调用；rt 非对象或未 stash → undefined）。 */
export function readRtSnapshot<T>(rt: object | undefined | null): T | undefined {
  if (!rt || typeof rt !== 'object') return undefined
  return RT_SNAPSHOTS.get(rt) as T | undefined
}
