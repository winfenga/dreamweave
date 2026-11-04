/**
 * pipeline/ 门面（barrel）。
 *
 * 29 任务注册表（26 条真 LLM + 3 条纯本地：merge / canonical / draftAlign）经
 * `task-registry` → `dag` → `orchestrator` 编排；所有 LLM 调用统一走 `llm-client`
 * （任意 OpenAI 兼容、不绑定供应商）；超预算输入经 `batching`（L2 分批 + 机械合并 + 递归）。
 *
 * 供主进程按需 import，也供 node 验证脚本经 esbuild 打包后统一取用。
 */
export * from './task-registry'
export * from './dag'
export * from './prompt-loader'
export * from './merge'
export * from './batching'
export * from './llm-client'
export * from './providers'
export * from './memory'
export * from './persistence'
export * from './orchestrator'
export * from './tasks'
