import { describe, expect, test } from "bun:test"

describe("ci smoke", () => {
  test("intentionally fails to exercise the ci-doctor pipeline", () => {
    expect(1 + 1).toBe(2)
  })
})
