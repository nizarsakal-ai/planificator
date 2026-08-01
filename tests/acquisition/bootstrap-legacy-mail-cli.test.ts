/**
 * LOT-1C — preuve CLI bootstrap returnExisting (aligné module ops).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveBootstrapReturnExisting } from "../../scripts/bootstrap-integration-legacy-mail-connection"

describe("bootstrap-integration-legacy-mail-connection CLI", () => {
  it("défaut ⇒ returnExisting=true", () => {
    assert.equal(
      resolveBootstrapReturnExisting([
        "node",
        "script.ts",
        "--companyId=co1",
      ]),
      true
    )
  })

  it("--no-return-existing ⇒ returnExisting=false", () => {
    assert.equal(
      resolveBootstrapReturnExisting([
        "node",
        "script.ts",
        "--companyId=co1",
        "--no-return-existing",
      ]),
      false
    )
  })
})
