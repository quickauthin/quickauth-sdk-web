import { storage } from './storage'

const KEY = 'consent'

let cache: boolean | null = null
const listeners = new Set<(v: boolean) => void>()

export const consent = {
  /** Seed the in-memory cache from storage / explicit init value. */
  hydrate(initial?: boolean): void {
    if (typeof initial === 'boolean') {
      cache = initial
      storage.set(KEY, initial)
      return
    }
    const stored = storage.get<boolean>(KEY)
    cache = typeof stored === 'boolean' ? stored : false
  },
  get(): boolean {
    if (cache === null) consent.hydrate()
    return cache === true
  },
  set(value: boolean): void {
    const prev = cache
    cache = !!value
    storage.set(KEY, cache)
    if (prev !== cache) listeners.forEach((l) => l(cache!))
  },
  onChange(fn: (v: boolean) => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}
