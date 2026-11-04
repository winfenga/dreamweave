import type { DreamweaveApi } from './index'

declare global {
  interface Window {
    dreamweave: DreamweaveApi
  }
}

export {}
