import type { RpCompareApi } from '../shared/types'

declare global {
  interface Window {
    rpCompare: RpCompareApi
  }
}

export {}
