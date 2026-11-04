import type { FeatherApi } from './index'

declare global {
  interface Window {
    feather: FeatherApi
  }
}

export {}
