import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { segmentCommand } from "../segments.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fx = JSON.parse(
  fs.readFileSync(path.join(__dirname, "scanner-fixtures.json"), "utf8"),
)

test("scanner-facts: pinned commit", () => {
  assert.equal(fx.generatedFrom.commit, "7b3d4ce3a7")
  assert.ok(Array.isArray(fx.cases) && fx.cases.length > 0)
})

for (const c of fx.cases) {
  test(`scanner facts: ${c.name}`, () => {
    // Totality: segmentCommand must never throw on any corpus input.
    let seg
    let threw = false
    try {
      seg = segmentCommand(c.input)
    } catch (e) {
      threw = true
    }
    assert.equal(threw, false, `segmentCommand threw on ${JSON.stringify(c.input)}`)

    // Segmenter decision must match the recorded corpus decision.
    assert.equal(
      seg.ok,
      c.segmenter.ok,
      `segmentCommand.ok mismatch for ${JSON.stringify(c.input)}: got ${seg.ok}, expected ${c.segmenter.ok}`,
    )
    if (!c.segmenter.ok && c.segmenter.reason) {
      assert.equal(seg.reason, c.segmenter.reason)
    }

    const isScanned =
      c.kind === "scanned" ||
      (Array.isArray(c.resources.portable) && c.resources.portable.length > 0) ||
      (Array.isArray(c.resources.treeSitter) && c.resources.treeSitter.length > 0)

    if (seg.ok) {
      // Anti-drift coverage: segments must cover EVERY non-empty resource set
      // (portable AND tree-sitter), so a deny on a real scanner resource is
      // caught even when portable is opaque/empty.
      const segSet = new Set(seg.segments.map((s) => String(s).trim()))
      const resourceSets = []
      if (Array.isArray(c.resources.portable) && c.resources.portable.length > 0) {
        resourceSets.push(c.resources.portable)
      }
      if (Array.isArray(c.resources.treeSitter) && c.resources.treeSitter.length > 0) {
        resourceSets.push(c.resources.treeSitter)
      }
      const seen = new Set()
      for (const arr of resourceSets) {
        const key = JSON.stringify(arr)
        if (seen.has(key)) continue
        seen.add(key)
        for (const r of arr) {
          assert.ok(
            segSet.has(String(r).trim()),
            `missing segment for resource ${JSON.stringify(r)} in ${JSON.stringify(c.input)}`,
          )
        }
      }

      // Equality modulo elision: only when no parser divergence and no elided drops.
      if (
        !c.parserDivergent &&
        Array.isArray(c.elided) &&
        c.elided.length === 0 &&
        resourceSets.length > 0
      ) {
        const target =
          c.resources.portable.length > 0
            ? c.resources.portable
            : c.resources.treeSitter
        assert.deepEqual(seg.segments, target)
      }
    } else if (isScanned) {
      // Scanned reject cases: already asserted ok === false + reason above.
    }
  })
}
