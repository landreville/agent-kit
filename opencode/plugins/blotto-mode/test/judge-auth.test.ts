import { describe, expect, test } from "bun:test"
import { resolveAuthApiKey } from "../src/v2"

// The judge key lives in opencode's auth store. People mint per-plugin keys
// there (e.g. "litellm-blottomode"), so the resolver matches the canonical
// "litellm" id first, then any entry whose id starts with "litellm". A
// configured provider id always wins over both.
describe("resolveAuthApiKey", () => {
  test("exact litellm entry wins", () => {
    expect(
      resolveAuthApiKey({ litellm: { key: "k1" }, "litellm-bb": { key: "k2" } }),
    ).toBe("k1")
  })

  test("prefixed entries match when no exact entry exists", () => {
    expect(resolveAuthApiKey({ "litellm-blottomode": { key: "k2" } })).toBe("k2")
  })

  test("configured provider id beats the prefix scan", () => {
    expect(
      resolveAuthApiKey({ "litellm-blottomode": { key: "k2" } }, "litellm-blottomode"),
    ).toBe("k2")
    expect(resolveAuthApiKey({ litellm: { key: "k1" }, "litellm-blottomode": { key: "k2" } }, "litellm-blottomode")).toBe("k2")
  })

  test("non-litellm entries are never used", () => {
    expect(resolveAuthApiKey({ anthropic: { key: "sk-ant" }, opencode: { key: "tok" } })).toBe("")
  })

  test("malformed entries yield empty", () => {
    expect(resolveAuthApiKey({ litellm: "garbage" })).toBe("")
    expect(resolveAuthApiKey({ litellm: { key: 42 } })).toBe("")
    expect(resolveAuthApiKey({ litellm: { key: "   " } })).toBe("")
    expect(resolveAuthApiKey(null)).toBe("")
  })

  test("opencode-native auth shapes without a top-level key are not misread", () => {
    // opencode auth entries can carry extra fields; extra fields must not
    // become the credential.
    expect(
      resolveAuthApiKey({ litellm: { type: "api", key: "k3", createdAt: 1 } }),
    ).toBe("k3")
  })
})
