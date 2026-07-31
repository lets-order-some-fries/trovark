const BANDS: Array<[lo: number, hi: number, letter: string]> = [
  [85, 100, 'A'], [70, 84, 'B'], [55, 69, 'C'], [40, 54, 'D'],
]

export function grade(score: number): string {
  const v = Math.round(score)
  for (const [lo, hi, letter] of BANDS) {
    if (v >= lo && v <= hi) {
      if (v >= hi - 4) return `${letter}+`
      if (v <= lo + 4) return `${letter}-`
      return letter
    }
  }
  return 'F'
}
