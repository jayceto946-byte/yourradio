import test from "node:test";
import assert from "node:assert/strict";
import { containsChinese, normalizeMusicText } from "../lib/musicText/normalizeMusicText";

test("normalizeMusicText normalizes full-width text and spaces", () => {
  assert.equal(normalizeMusicText(" Ａ  B　C "), "A B C");
});

test("containsChinese detects Chinese but not English", () => {
  assert.equal(containsChinese("富士山下"), true);
  assert.equal(containsChinese("Eason Chan"), false);
});

// These tests are intended to run in a TS-aware runner after build tooling is added.
// They document the expected behavior of buildLastfmQueryVariants:
// - simplified input yields traditional / traditional_hk / traditional_tw variants
// - traditional input yields simplified variants
// - artist aliases generate artist_alias variants
// - duplicate title + artist variants keep the highest weight
// - English-only input does not create Chinese conversion variants
