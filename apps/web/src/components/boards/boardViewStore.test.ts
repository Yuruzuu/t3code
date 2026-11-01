import { BoardPostId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  boardTabAfterClosing,
  moveBoardTab,
  upsertBoardTab,
  type BoardTab,
} from "./boardViewStore";

const tab = (id: string, title = id): BoardTab => ({
  rootId: BoardPostId.make(id),
  channelName: "general",
  title,
  author: { kind: "user" },
});
const ids = (tabs: readonly BoardTab[]) => tabs.map((item) => item.rootId);

it("opens a discussion once, keeping its place when its title changes", () => {
  const tabs = [tab("a"), tab("b")];

  expect(ids(upsertBoardTab(tabs, tab("c")))).toEqual(["a", "b", "c"]);
  expect(upsertBoardTab(tabs, tab("a"))).toBe(tabs);
  expect(upsertBoardTab(tabs, tab("a", "Renamed")).map((item) => item.title)).toEqual([
    "Renamed",
    "b",
  ]);
});

it("reorders tabs and ignores a discussion that is no longer open", () => {
  const tabs = [tab("a"), tab("b"), tab("c")];

  expect(ids(moveBoardTab(tabs, BoardPostId.make("a"), 2))).toEqual(["b", "c", "a"]);
  expect(ids(moveBoardTab(tabs, BoardPostId.make("c"), 0))).toEqual(["c", "a", "b"]);
  expect(moveBoardTab(tabs, BoardPostId.make("gone"), 0)).toBe(tabs);
});

it("shows the next tab after closing one, then the previous, then none", () => {
  const tabs = [tab("a"), tab("b"), tab("c")];

  expect(boardTabAfterClosing(tabs, BoardPostId.make("a"))?.rootId).toBe("b");
  expect(boardTabAfterClosing(tabs, BoardPostId.make("c"))?.rootId).toBe("b");
  expect(boardTabAfterClosing([tab("a")], BoardPostId.make("a"))).toBeNull();
});
