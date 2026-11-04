/**
 * 任务适配器注册表。
 *
 * - `cacheWarmingAdapter`：M2 唯一落地的真 LLM 任务适配器；
 * - `segAdapter` / `plotAdapter` / `settingSummaryAdapter` / `chunkLocationSummaryAdapter`：
 *   T6-A 第一批落地的 4 条 LLM 解析任务适配器（与 cacheWarming 同构）；
 * - `worldImpressionAdapter`：T6-B 落地的聚合型适配器（读全部 plot 摘要，全书一次）；
 * - `locationTreeAdapter`：T6-C 落地的聚合型适配器（读全部 chunkLocationSummary 摘要，
 *   单轮全文模式产出最终 locations + tree）；
 * - `batchLocationSummaryAdapter`：T6-F 第六批落地的聚合型适配器（读 locationTree 产物
 *   的可展示地点索引 + 全部 chunkLocationSummary 摘要，单轮全文模式产出单字符串
 *   batchLocationSummary；与 impressionLayout/plotLocation 共享 `../location-inputs`）；
 * - `impressionLayoutAdapter`：T6-F 第六批落地的聚合型适配器（读 locationTree 可展示
 *   地点索引 + batchLocationSummary 产物，产出世界印象地图布局
 *   `{layout:{gridSize,layouts},warnings}`；rect 协议校验 + 无效项丢弃不抛崩）；
 * - `plotLocationAdapter`：T6-F 第六批落地的 per-chunk 适配器（叶真源产物落
 *   `world/plot-locations.json`；parse 用 `rt.chunkIndex` 重编全局唯一 id
 *   `L-{chunk}-l{n}`——模型自产 id 是 chunk 本地短 id会碰撞；protocol/actions 为程序字段）；
 * - `characterAppearanceAdapter`：T6-G 第七批落地的聚合型适配器（读 canonical 的
 *   `objects.characters`，产出主条目 MAP 形态 `{charId: [形象对象...]}`——
 *   `appearanceId={charId}-A-{n+1}` 与 `chunkIndexes` 由程序据来源分配，模板明言
 *   「无需生成」；sourceIndexes 解析依据 buildMessages 经 `../rt-stash` 挂的快照）；
 * - `lineAnnotationAdapter`：T6-G 第七批落地的 per-chunk 适配器（逐行标注，叶真源
 *   产物落 `script/line-annotation.json`；声明 `batching:{inputBudgetTokens:100000}`
 *   强制单批——输出含跨批必碰撞的本地行引用；plotLocations 用 `rt.chunkIndex` 重编
 *   `L-{chunk}-l{n}`（同 plotLocation），行条目展开/继承/行覆盖校验）；
 * - `draftAdapter` / `draftCharacterAdapter` / `draftOtherAdapter`：T6-D 第四批落地的
 *   3 条 per-chunk 草稿适配器（阅读记忆由 `../memory` 从 plot 产物现算；parse 只产
 *   模型数据，id/draftIds/chunkSummaryList 由 T6-E merge 本地步骤统一分配）；
 * - `characterRelationAdapter`：T6-H 第八批落地的 per-chunk 适配器（人物关系提取，产物落
 *   `records/results/characterRelation.json`；章序越界**钳制**不丢弃、A=B 跳过、长度契约
 *   只 warning 不截断、`chunkIndex` 由程序补齐；**不提供 keyOf**——关系无稳定 id，复合键会
 *   误塌同对人物不同范围的多条合法记录）；
 * - `storyScriptAdapter`：T6-H 第八批落地的 per-chunk 适配器（演出脚本，叶真源产物落
 *   `script/story-script.<chunk>.json`；声明 `batching:{inputBudgetTokens:100000}` 强制单批；
 *   模板变体按 `manifest.project.storyScriptStyle` 选 `coherent` / base（legacy 系回落 base
 *   + warning）；parse 把短字段协议 story-fields-v2 展开成严格 10 键长字段，`@#a-b#@` 行引用
 *   解析为原文行文本（越界保留标记不猜），plotLocations 从快照原样复制）；
 * - `plotLocationMergeAdapter`：T6-H 第八批落地的 **global** 适配器（跨 chunk 合并可共用
 *   背景图的剧情地点，产物落 `records/results/plotLocationMerge.json`；声明
 *   `batching:{inputBudgetTokens:100000}`——切批会让同一地点各批各自分组、`PL-*` 跨批碰撞；
 *   parse 按输入序汇编 `PL-{n}` 与全覆盖 `idMap`，组 id 先到先得）；
 * - `mergeReviewAdapter`：T6-E 第五批落地的实体复核适配器，注册表 4 条独立 TaskDef
 *   （`mergeReview:characters|factions|items|creatures`，各带 feature）**共用同一
 *   适配器对象**，类目从 `rt.task.feature` 取；产物 4 类目同写
 *   `records/results/mergeReview.json`（key 后缀区分）；
 * - `LOCAL_STEPS`：四条 `model:false` 本地程序步骤（merge/canonical/draftAlign/event，
 *   T6-E 起前三条为真实实体合并语义、D1 起 event 为纯程序事件树，见 `./local.ts` 文件头）；
 * - 其余 21 条任务适配器按里程碑（M3~M7）逐步登记；未登记者在编排器中被标记 `skipped`。
 */
import type { LlmTaskAdapter, LocalTaskStep } from '../../../shared/pipeline-types'
import { cacheWarmingAdapter } from './cacheWarming'
import { segAdapter } from './seg'
import { plotAdapter } from './plot'
import { settingSummaryAdapter } from './settingSummary'
import { chunkLocationSummaryAdapter } from './chunkLocationSummary'
import { worldImpressionAdapter } from './worldImpression'
import { locationTreeAdapter } from './locationTree'
import { batchLocationSummaryAdapter } from './batchLocationSummary'
import { impressionLayoutAdapter } from './impressionLayout'
import { plotLocationAdapter } from './plotLocation'
import { characterAppearanceAdapter } from './characterAppearance'
import { lineAnnotationAdapter } from './lineAnnotation'
import { characterRelationAdapter } from './characterRelation'
import { storyScriptAdapter } from './storyScript'
import { plotLocationMergeAdapter } from './plotLocationMerge'
import { draftAdapter } from './draft'
import { draftCharacterAdapter } from './draftCharacter'
import { draftOtherAdapter } from './draftOther'
import { mergeReviewAdapter } from './mergeReview'
import { mangaScriptAdapter } from './mangaScript'
import { mangaEffectsAdapter } from './mangaEffects'
import { mangaMusicAdapter } from './mangaMusic'
import { mangaMusicMergeAdapter } from './mangaMusicMerge'
import { LOCAL_STEPS } from './local'

/** 已登记的 LLM 任务适配器（key = task id）。 */
export const LLM_ADAPTERS: Record<string, LlmTaskAdapter> = {
  cacheWarming: cacheWarmingAdapter,
  seg: segAdapter,
  plot: plotAdapter,
  settingSummary: settingSummaryAdapter,
  chunkLocationSummary: chunkLocationSummaryAdapter,
  worldImpression: worldImpressionAdapter,
  locationTree: locationTreeAdapter,
  batchLocationSummary: batchLocationSummaryAdapter,
  impressionLayout: impressionLayoutAdapter,
  plotLocation: plotLocationAdapter,
  characterAppearance: characterAppearanceAdapter,
  lineAnnotation: lineAnnotationAdapter,
  characterRelation: characterRelationAdapter,
  storyScript: storyScriptAdapter,
  plotLocationMerge: plotLocationMergeAdapter,
  draft: draftAdapter,
  draftCharacter: draftCharacterAdapter,
  draftOther: draftOtherAdapter,
  // T6-E：mergeReview 注册表 4 键（task-registry 的 4 条 TaskDef）指向同一适配器对象
  'mergeReview:characters': mergeReviewAdapter,
  'mergeReview:factions': mergeReviewAdapter,
  'mergeReview:items': mergeReviewAdapter,
  'mergeReview:creatures': mergeReviewAdapter,
  // C 线：漫画生产链（与正片的 storyScript/effectAnnotation 并列，不是覆盖）
  mangaScript: mangaScriptAdapter,
  mangaEffects: mangaEffectsAdapter,
  mangaMusic: mangaMusicAdapter,
  mangaMusicMerge: mangaMusicMergeAdapter
}

/** 已登记的本地程序步骤（key = task id）。 */
export const LOCAL_STEP_MAP: Record<string, LocalTaskStep> = Object.fromEntries(
  LOCAL_STEPS.map((s) => [s.id, s])
)

export { cacheWarmingAdapter } from './cacheWarming'
export { segAdapter, segKeyOf } from './seg'
export { plotAdapter, plotKeyOf } from './plot'
export { settingSummaryAdapter } from './settingSummary'
export { chunkLocationSummaryAdapter } from './chunkLocationSummary'
export { worldImpressionAdapter } from './worldImpression'
export { locationTreeAdapter, locationTreeKeyOf } from './locationTree'
export { batchLocationSummaryAdapter } from './batchLocationSummary'
export { impressionLayoutAdapter, impressionLayoutKeyOf } from './impressionLayout'
export { plotLocationAdapter, plotLocationKeyOf } from './plotLocation'
export { characterAppearanceAdapter, characterAppearanceKeyOf } from './characterAppearance'
export { lineAnnotationAdapter, lineAnnotationKeyOf } from './lineAnnotation'
export { characterRelationAdapter } from './characterRelation'
export { storyScriptAdapter, storyScriptKeyOf } from './storyScript'
export { plotLocationMergeAdapter, plotLocationMergeKeyOf } from './plotLocationMerge'
export { draftAdapter, draftKeyOf } from './draft'
export { draftCharacterAdapter } from './draftCharacter'
export { draftOtherAdapter } from './draftOther'
export { mergeReviewAdapter, mergeReviewKeyOf } from './mergeReview'
export { mangaScriptAdapter } from './mangaScript'
export { mangaEffectsAdapter, MANGA_EFFECT_CATALOG } from './mangaEffects'
export { mangaMusicAdapter } from './mangaMusic'
export { mangaMusicMergeAdapter } from './mangaMusicMerge'
export { LOCAL_STEPS, LOCAL_TASK_IDS } from './local'
