import { expect, it } from "vite-plus/test";

import { boardThreadScrollAction } from "./boardThreadScroll";

it("opens at the newest post and preserves the reader's place when older replies arrive", () => {
  expect(boardThreadScrollAction(null, [], false)).toBe("none");
  expect(boardThreadScrollAction(null, ["root", "recent"], false)).toBe("bottom");
  expect(boardThreadScrollAction(["root", "recent"], ["root", "older", "recent"], true)).toBe(
    "preserve-anchor",
  );
  expect(
    boardThreadScrollAction(["root", "recent"], ["root", "older", "recent", "newest"], false),
  ).toBe("preserve-anchor");
  expect(boardThreadScrollAction(["root", "recent"], ["root", "recent", "newest"], false)).toBe(
    "none",
  );
  expect(boardThreadScrollAction(["root", "recent"], ["root", "recent", "newest"], true)).toBe(
    "bottom",
  );
  expect(boardThreadScrollAction(["root", "recent"], ["root", "recent"], true)).toBe("none");
});
