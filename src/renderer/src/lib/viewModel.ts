/**
 * 渲染模型辅助：把主进程下发的 ViewData 整理成视图友好的查表结构。
 * 只做纯函数整理，不发起 IPC、不碰 DOM。
 */
import type {
  ChapterSpan,
  CharacterPortrait,
  CharacterVisual,
  DubbingClip,
  SceneInfo,
  StageAction,
  ViewData
} from '../../../shared/app-types'

export interface ViewLookups {
  sceneById: Map<string, SceneInfo>
  /** 场景 id -> 场景图常驻 URL（id 形态随包不同，不假设前缀） */
  sceneImageBySceneId: Map<string, string>
  /** M-5 -> 该节点上的场景 */
  scenesByNodeId: Map<string, SceneInfo[]>
  characterById: Map<string, CharacterVisual>
  /** dantes -> 立绘常驻 URL */
  characterImageById: Map<string, string>
  /** 场景 id -> 场景名（用于 UI 标签） */
  sceneNameById: Map<string, string>
  /** characterId -> 全部立绘形象（立绘放大模态用） */
  portraitsById: Map<string, CharacterPortrait[]>
  /** `${actionType}|${chapterSeq}|${order}` -> 包内配音片段（无配音的包为空表） */
  dubbingByKey: Map<string, DubbingClip>
}

/** 动作 → 配音片段复合键（与主进程 view.ts 的生成规则一致） */
export function dubbingKey(a: StageAction): string {
  return `${a.type}|${a.chapterSeq}|${a.order}`
}

export function buildLookups(v: ViewData): ViewLookups {
  const scenesByNodeId = new Map<string, SceneInfo[]>()
  for (const s of v.scenes) {
    if (!s.mapLocationId) continue
    const arr = scenesByNodeId.get(s.mapLocationId) ?? []
    arr.push(s)
    scenesByNodeId.set(s.mapLocationId, arr)
  }
  const portraitsById = new Map<string, CharacterPortrait[]>()
  for (const c of v.characters) portraitsById.set(c.id, c.portraits)
  return {
    sceneById: new Map(v.scenes.map((s) => [s.id, s])),
    sceneImageBySceneId: new Map(v.scenes.filter((s) => s.imageUrl).map((s) => [s.id, s.imageUrl as string])),
    scenesByNodeId,
    characterById: new Map(v.characters.map((c) => [c.id, c])),
    characterImageById: new Map(v.characters.filter((c) => c.imageUrl).map((c) => [c.id, c.imageUrl as string])),
    sceneNameById: new Map(v.scenes.map((s) => [s.id, s.name])),
    portraitsById,
    dubbingByKey: new Map((v.dubbing ?? []).map((d) => [d.key, d]))
  }
}

/** 取某章第 offset 条动作 */
export function actionAt(v: ViewData, chapterIdx: number, offset: number): StageAction | null {
  const ch: ChapterSpan | undefined = v.chapters[chapterIdx]
  if (!ch) return null
  const i = ch.start + offset
  if (i < 0 || i >= ch.end) return null
  return v.actions[i] ?? null
}

/** 舞台背景图 URL（场景缺失时返回 null，由视图显示占位） */
export function backgroundUrl(lookups: ViewLookups, action: StageAction | null): string | null {
  if (!action?.locationId) return null
  return lookups.sceneImageBySceneId.get(action.locationId) ?? null
}

/** 立绘 URL（无角色或无立绘时返回 null） */
export function portraitUrl(lookups: ViewLookups, action: StageAction | null): string | null {
  if (!action?.characterId) return null
  return lookups.characterImageById.get(action.characterId) ?? null
}

/** 说话人显示名 */
export function speakerName(lookups: ViewLookups, action: StageAction | null): string {
  if (!action?.characterId) return ''
  return lookups.characterById.get(action.characterId)?.name ?? action.characterId
}

/** 场景显示名 */
export function sceneName(lookups: ViewLookups, action: StageAction | null): string {
  if (!action?.locationId) return ''
  return lookups.sceneNameById.get(action.locationId) ?? action.locationId
}
