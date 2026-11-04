/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

// window.feather 的完整类型由 src/preload/index.ts 提供（单一事实来源），
// 这里不再重复声明，避免新增 IPC 时两边不同步。
