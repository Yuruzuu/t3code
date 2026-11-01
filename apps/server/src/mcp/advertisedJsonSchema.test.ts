import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import { MessageBoardToolkit } from "./toolkits/messageBoard/tools.ts";

const decodeTodoRead = Schema.decodeUnknownSync(
  MessageBoardToolkit.tools.board_read_todos.parametersSchema,
);

it("drops JSON noise while preserving meaningful nulls and branch requirements", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { anyOf: [{ type: "string" }, { type: "null" }] },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      target: {
        anyOf: [
          {
            type: "object",
            properties: { kind: { type: "string", enum: ["url"] }, url: { type: "string" } },
            required: ["kind", "url"],
          },
          {
            type: "object",
            properties: { kind: { type: "string", enum: ["number"] }, number: { type: "integer" } },
            required: ["kind", "number"],
          },
          { type: "null" },
        ],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("advertises a todo action's task, version, and request key as required in their branches", () => {
  const tool = Tool.make("todo_action", {
    parameters: Schema.Struct({
      request_key: Schema.String,
      action: Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("create"),
          text: Schema.String,
          assignee: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
        Schema.Struct({
          kind: Schema.Literal("complete"),
          todo_id: Schema.String,
          expected_version: Schema.Int,
        }),
      ]),
    }),
  });
  expect(advertisedJsonSchema(tool)).toMatchObject({
    required: ["request_key", "action"],
    properties: {
      action: {
        anyOf: [
          {
            required: ["kind", "text"],
            properties: { assignee: { anyOf: [{ type: "string" }, { type: "null" }] } },
          },
          { required: ["kind", "todo_id", "expected_version"] },
        ],
      },
    },
  });
});

it("keeps actual todo tool requirements and nullable reassignment visible", () => {
  expect(advertisedJsonSchema(MessageBoardToolkit.tools.board_todo_action)).toMatchObject({
    required: ["thread_id", "request_key", "action"],
    properties: {
      action: {
        anyOf: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({ type: { type: "string", enum: ["start"] } }),
            required: ["type", "todoId", "expectedVersion"],
          }),
          expect.objectContaining({
            properties: expect.objectContaining({
              type: { type: "string", enum: ["create"] },
              status: { type: "string", enum: ["blocked"] },
            }),
            required: ["type", "text", "status", "reason"],
          }),
          expect.objectContaining({
            properties: expect.objectContaining({
              type: { type: "string", enum: ["reassign"] },
              assigneeThreadId: { anyOf: [{ type: "string" }, { type: "null" }] },
            }),
            required: ["type", "todoId", "expectedVersion", "assigneeThreadId", "reason"],
          }),
          expect.objectContaining({
            properties: expect.objectContaining({
              type: { type: "string", enum: ["create"] },
              assigneeThreadId: { anyOf: [{ type: "string" }, { type: "null" }] },
            }),
            required: ["type", "text"],
          }),
        ]),
      },
    },
  });
  expect(advertisedJsonSchema(MessageBoardToolkit.tools.board_read_todos)).toMatchObject({
    required: ["thread_id", "query"],
    properties: {
      query: {
        anyOf: expect.arrayContaining([
          expect.objectContaining({ required: ["type", "todoId"] }),
          expect.objectContaining({ required: ["type"] }),
        ]),
      },
    },
  });
  expect(() =>
    decodeTodoRead({
      thread_id: "discussion",
      query: { type: "get", todoId: "task", filter: "all" },
    }),
  ).toThrow();
});
