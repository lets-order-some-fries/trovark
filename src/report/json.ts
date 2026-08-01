import type { Scorecard } from '../types.js'

export function renderJson(card: Scorecard): string {
  return JSON.stringify(card, null, 2)
}
