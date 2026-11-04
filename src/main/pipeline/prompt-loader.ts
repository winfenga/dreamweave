/**
 * 提示词模板加载 + 变量注入（设计 §6.1；recon §7「上下文拼接」）。
 *
 * 模板是**构建期静态资产**（`resources/prompts/<name>.txt`，36 份）。语法为 mustache 简版：
 *   - `{{{var}}}` / `{{var}}`  变量替换（缺失 → 空串；不做 HTML 转义，均为纯文本提示词）
 *   - `{{#name}}…{{/name}}`    区段（值真值才渲染）
 *   - `{{^name}}…{{/name}}`    反转区段（值假值才渲染）
 * 区段可嵌套。变量值：字符串原样；数组按行连接；对象 JSON 序列化。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resourcesDir } from '../effects/catalog'

/** 字符串化一个变量值。 */
export function stringifyVar(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (Array.isArray(v)) return v.map((x) => stringifyVar(x)).join('\n')
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** 真值判定（区段开关）。 */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false
  if (v === true) return true
  if (typeof v === 'string') return v.length > 0
  if (typeof v === 'number') return v !== 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

/**
 * mustache 简版渲染。
 * 采用递归下降：先处理区段（含嵌套），再替换变量。
 */
export function renderTemplate(tpl: string, vars: Record<string, unknown> = {}): string {
  return renderSection(tpl, vars)
}

function renderSection(tpl: string, vars: Record<string, unknown>): string {
  let out = ''
  let i = 0
  while (i < tpl.length) {
    const open = tpl.indexOf('{{', i)
    if (open < 0) {
      out += tpl.slice(i)
      break
    }
    out += tpl.slice(i, open)
    // 处理 `{{{` 三花括号（变量，不转义）
    if (tpl.startsWith('{{{', open)) {
      const end = tpl.indexOf('}}}', open + 3)
      if (end < 0) {
        out += tpl.slice(open)
        break
      }
      const name = tpl.slice(open + 3, end).trim()
      out += stringifyVar(lookup(vars, name))
      i = end + 3
      continue
    }
    const end = tpl.indexOf('}}', open + 2)
    if (end < 0) {
      out += tpl.slice(open)
      break
    }
    const token = tpl.slice(open + 2, end).trim()
    if (token.startsWith('#') || token.startsWith('^')) {
      const inverted = token.startsWith('^')
      const name = token.slice(1).trim()
      // 找配对的 {{/name}}（支持同名嵌套）
      const body = findSection(tpl, open, name)
      if (!body) {
        out += tpl.slice(open, end + 2)
        i = end + 2
        continue
      }
      const value = lookup(vars, name)
      if (inverted ? !truthy(value) : truthy(value)) {
        out += renderSection(body.body, vars)
      }
      i = body.after
      continue
    }
    out += stringifyVar(lookup(vars, token))
    i = end + 2
  }
  return out
}

/** 从 `open` 起找 `{{#name}}`/`{{^name}}` 的配对 `{{/name}}`，返回体内文本与结束位置。 */
function findSection(tpl: string, open: number, name: string): { body: string; after: number } | null {
  const tagEnd = tpl.indexOf('}}', open + 2)
  if (tagEnd < 0) return null
  let depth = 1
  let cursor = tagEnd + 2
  const openRe = new RegExp(`\\{\\{[#^]\\s*${escapeRe(name)}\\s*\\}\\}`, 'g')
  const closeRe = new RegExp(`\\{\\{\\/\\s*${escapeRe(name)}\\s*\\}\\}`, 'g')
  while (cursor < tpl.length) {
    closeRe.lastIndex = cursor
    const close = closeRe.exec(tpl)
    if (!close) return null
    openRe.lastIndex = cursor
    let nested = openRe.exec(tpl)
    while (nested && nested.index < close.index) {
      depth++
      cursor = nested.index + nested[0].length
      openRe.lastIndex = cursor
      nested = openRe.exec(tpl)
    }
    depth--
    if (depth === 0) {
      const body = tpl.slice(tagEnd + 2, close.index)
      return { body, after: close.index + close[0].length }
    }
    cursor = close.index + close[0].length
  }
  return null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 按键查值（支持 `a.b` 点路径）。 */
function lookup(vars: Record<string, unknown>, path: string): unknown {
  if (!path) return ''
  if (path in vars) return vars[path]
  const parts = path.split('.')
  let cur: unknown = vars
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return ''
    }
  }
  return cur
}

/** 模板文件路径（`<resources>/prompts/<name>.txt`）。 */
export function promptPath(name: string): string {
  const base = name.replace(/\.txt$/, '')
  return join(resourcesDir(), 'prompts', `${base}.txt`)
}

/** 读取模板原文（缺失/不可读 → 抛可读错误）。 */
export async function loadPrompt(name: string): Promise<string> {
  const path = promptPath(name)
  try {
    return await readFile(path, 'utf8')
  } catch (e) {
    throw new Error(`提示词模板不可用：${path}（${(e as Error).message}）`)
  }
}

/** 读取模板并注入变量。 */
export async function renderPrompt(name: string, vars: Record<string, unknown> = {}): Promise<string> {
  const tpl = await loadPrompt(name)
  return renderTemplate(tpl, vars)
}
