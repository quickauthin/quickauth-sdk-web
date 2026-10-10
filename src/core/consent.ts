import { logger } from './logger'
import { storage } from './storage'

const KEY = 'consent'

let cache: boolean | null = null
const listeners = new Set<(v: boolean) => void>()

export const consent = {
  hydrate(initial?: boolean): void {
    const stored = storage.get<boolean>(KEY)
    cache = typeof stored === 'boolean' ? stored : initial === true
  },
  get(): boolean {
    if (cache === null) consent.hydrate()
    return cache === true
  },
  set(value: boolean): void {
    const prev = cache
    cache = !!value
    storage.set(KEY, cache)
    if (prev === cache) return
    for (const l of Array.from(listeners)) {
      try {
        l(cache)
      } catch (err) {
        logger.error('consent.onChange listener threw:', err)
      }
    }
  },
  onChange(fn: (v: boolean) => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}
