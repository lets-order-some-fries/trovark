import { describe, expect, it } from 'vitest'
import { grade } from '../src/scoring/score.js'

describe('grade bands (A>=85, B>=70, C>=55, D>=40, F<40; +/- at band edges)', () => {
  it.each([
    [100, 'A+'], [96, 'A+'], [95, 'A'], [90, 'A'], [89, 'A-'], [85, 'A-'],
    [84, 'B+'], [80, 'B+'], [79, 'B'], [75, 'B'], [74, 'B-'], [70, 'B-'],
    [69, 'C+'], [65, 'C+'], [64, 'C'], [60, 'C'], [59, 'C-'], [55, 'C-'],
    [54, 'D+'], [50, 'D+'], [49, 'D'], [45, 'D'], [44, 'D-'], [40, 'D-'],
    [39, 'F'], [0, 'F'],
  ])('grade(%i) === %s', (n, expected) => {
    expect(grade(n)).toBe(expected)
  })
})
