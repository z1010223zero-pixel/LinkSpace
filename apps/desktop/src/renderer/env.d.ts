import type { LinkSpaceApi } from '../shared/types'

declare global {
  interface Window {
    linkspace: LinkSpaceApi
  }
}

export {}
