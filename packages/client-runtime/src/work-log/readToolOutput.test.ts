import { describe, expect, it } from "vite-plus/test";

import { readToolFile } from "./readToolOutput.js";

describe("readToolFile", () => {
  it("reads Claude's structured file result, as an object or JSON text", () => {
    const output = {
      type: "text",
      file: { filePath: "/repo/a.luau", content: "local x = 1\nreturn x", startLine: 12 },
    };
    expect(readToolFile(output)).toEqual({ content: "local x = 1\nreturn x", startLine: 12 });
    expect(readToolFile(JSON.stringify(output))).toEqual({
      content: "local x = 1\nreturn x",
      startLine: 12,
    });
  });

  it("strips line-number prefixes from the text form", () => {
    expect(readToolFile("     4→first\n     5→\tindented\n")).toEqual({
      content: "first\n\tindented",
      startLine: 4,
    });
  });

  it("leaves other output to the generic renderer", () => {
    expect(readToolFile("plain output")).toBeNull();
    expect(readToolFile({ type: "image", file: { base64: "AAAA" } })).toBeNull();
    expect(readToolFile('{"type":"text","file":{"content":"trunc')).toBeNull();
  });
});
