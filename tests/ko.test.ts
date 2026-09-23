import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KO } from "../ko";

// Every literal the plugin shows through `t("…")`, read from the source the way the editor's own extractor reads it.
const source = readFileSync(new URL("../plugin.ts", import.meta.url), "utf8");
const keys = new Set([...source.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string));

describe("the Korean catalogue", () => {
  it("has every string the plugin shows", () => {
    expect([...keys].filter((k) => !(k in KO))).toEqual([]);
  });

  it("has nothing the plugin no longer shows", () => {
    expect(Object.keys(KO).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("keeps every placeholder", () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
    for (const [en, ko] of Object.entries(KO)) expect(names(ko), en).toEqual(names(en));
  });
});
