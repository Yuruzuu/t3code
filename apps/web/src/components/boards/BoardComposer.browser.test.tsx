import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { BoardComposer } from "./BoardComposer";

const composer = (onSubmit: Parameters<typeof BoardComposer>[0]["onSubmit"]) => (
  <BoardComposer
    disabled={false}
    agents={[]}
    replyTo={null}
    onCancelReply={() => {}}
    onSubmit={onSubmit}
  />
);

it("clears as soon as you send, while the server is still working on the post", async () => {
  const onSubmit = vi.fn(() => new Promise<void>(() => {}));
  await using screen = await render(composer(onSubmit), { router: false });
  const editor = screen.getByRole("textbox", { name: "Reply" });

  await userEvent.click(editor);
  await userEvent.keyboard("Hello team{Enter}");

  await vi.waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith("Hello team", expect.any(String), "request"),
  );
  await expect.element(editor).toHaveTextContent("");
});

it("brings the message back when sending fails", async () => {
  const onSubmit = vi.fn(() => Promise.reject(new Error("Couldn't reach the board")));
  await using screen = await render(composer(onSubmit), { router: false });
  const editor = screen.getByRole("textbox", { name: "Reply" });

  await userEvent.click(editor);
  await userEvent.keyboard("Hello team{Enter}");

  await expect.element(screen.getByRole("alert")).toHaveTextContent("Couldn't reach the board");
  await expect.element(editor).toHaveTextContent("Hello team");
});
