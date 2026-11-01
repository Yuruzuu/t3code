import { BoardPost, BoardPostId, CommandId, ThreadId } from "@t3tools/contracts";
import { boardPersona } from "@t3tools/shared/boardPersona";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as BoardHandlingGuard from "../orchestration-v2/BoardHandlingGuard.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as HandlingEvents from "./MessageBoardHandlingEvents.ts";
import * as Handling from "./MessageBoardHandlingStore.ts";
import * as SelectionStore from "./MessageBoardSelectionStore.ts";
import * as Decisions from "./OpenAIDecisionsClient.ts";

export class ResponderSelectionError extends Schema.TaggedError<ResponderSelectionError>()(
  "ResponderSelectionError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const decodePost = Schema.decodeUnknownEffect(BoardPost);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type BeforeStartInput = { readonly batchId: string; readonly threadId: ThreadId };
export class MessageBoardResponderSelection extends Context.Service<
  MessageBoardResponderSelection,
  {
    readonly activate: (
      rootId?: BoardPostId,
    ) => Effect.Effect<ReadonlyArray<SelectionStore.Selection>, ResponderSelectionError>;
    readonly recover: () => Effect.Effect<
      ReadonlyArray<SelectionStore.Selection>,
      ResponderSelectionError
    >;
    readonly reselectBeforeStart: (
      input: BeforeStartInput,
    ) => Effect.Effect<boolean, ResponderSelectionError>;
  }
>()("t3/messageBoard/MessageBoardResponderSelection") {}

export const classifyAvailability = Effect.fn(
  "MessageBoardResponderSelection.classifyAvailability",
)(
  function* (threadId: ThreadId) {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const shell = yield* projections.getThreadShell(threadId);
    if (shell === null) return "missing" as const;
    if (shell.deletedAt !== null) return "deleted" as const;
    if (shell.archivedAt != null) return "archived" as const;
    const records = yield* projections.getThreadRecords(threadId, ["runs", "turnItems"]);
    const lineage = records.thread.lineage;
    if (lineage.relationshipToParent === "subagent" && lineage.parentThreadId !== null) {
      if (yield* BoardHandlingGuard.isBoardHandlingStopped({ threadId: lineage.parentThreadId }))
        return "parent-stopped" as const;
    }
    if (yield* BoardHandlingGuard.isBoardHandlingStopped({ threadId })) return "stopped" as const;
    return null;
  },
  Effect.orElseSucceed(() => "unavailable" as const),
);

const makeShared = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const fingerprint = Effect.fn("MessageBoardResponderSelection.fingerprint")(function* (
    value: string,
  ) {
    return Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(value)));
  });
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* HandlingEvents.MessageBoardHandlingEvents;
  const handling = yield* Handling.make;
  const store = yield* SelectionStore.make;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const eligible = Effect.fn("MessageBoardResponderSelection.eligible")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* projections
      .getThreadShell(threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null || shell.archivedAt != null) return null;
    const reason = yield* classifyAvailability(threadId).pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    return reason === null ? shell : null;
  });
  const loadContext = Effect.fn("MessageBoardResponderSelection.loadContext")(function* (
    selection: SelectionStore.Selection,
  ) {
    const discussions = yield* sql<{
      context_json: string;
      context_revision: number;
      lifecycle: string;
    }>`SELECT context_json,context_revision,lifecycle FROM board_discussions WHERE root_id=${selection.rootId}`;
    const posts = yield* sql<{
      id: string;
      author_thread_id: string | null;
      text: string;
      created_at: string;
      reply_to_id: string | null;
    }>`SELECT id,json_extract(author_json,'$.threadId') AS author_thread_id,text,created_at,reply_to_id FROM board_posts WHERE root_id=${selection.rootId} AND json_extract(author_json,'$.kind') != 'system' ORDER BY created_at DESC,id DESC LIMIT 64`;
    const origins = yield* sql<{
      thread_id: string | null;
    }>`SELECT json_extract(author_json,'$.threadId') AS thread_id FROM board_posts WHERE id=${selection.rootId}`;
    const origin =
      selection.originThreadId ??
      (origins[0]?.thread_id ? ThreadId.make(origins[0].thread_id) : null);
    const participants = yield* sql<{
      thread_id: string;
    }>`SELECT json_extract(author_json,'$.threadId') AS thread_id FROM board_posts WHERE root_id=${selection.rootId} AND json_extract(author_json,'$.kind')='agent' GROUP BY thread_id ORDER BY MIN(created_at),thread_id LIMIT 64`;
    const subscriptions = yield* sql<{
      viewer_key: string;
    }>`SELECT viewer_key FROM board_subscriptions WHERE target_kind='thread' AND target=${selection.rootId} AND enabled=1 AND viewer_key LIKE 'thread:%' ORDER BY viewer_key LIMIT 64`;
    const identities = [
      ...new Set([
        ...participants.map((p) => ThreadId.make(p.thread_id)),
        ...subscriptions.map((s) => ThreadId.make(s.viewer_key.slice(7))),
        ...(origin ? [origin] : []),
      ]),
    ].slice(0, 64);
    const roster: Array<{ threadId: ThreadId; name: string; role: string }> = [];
    if (discussions[0]?.lifecycle === "open") {
      for (const threadId of identities) {
        const thread = yield* eligible(threadId);
        if (thread !== null) {
          const roles = yield* sql<{
            role: string;
          }>`SELECT role FROM board_roles WHERE thread_id=${threadId}`;
          roster.push({ threadId, name: boardPersona(threadId).name, role: roles[0]?.role ?? "" });
        }
        if (roster.length === 16) break;
      }
    }
    const authors = yield* sql<{
      thread_id: string;
    }>`SELECT json_extract(author_json,'$.threadId') AS thread_id FROM board_posts WHERE root_id=${selection.rootId} AND json_extract(author_json,'$.kind')='agent' ORDER BY created_at DESC,id DESC LIMIT 64`;
    const recentId = authors.find((p) => roster.some((r) => r.threadId === p.thread_id))?.thread_id;
    const fallback =
      roster.find((r) => r.threadId === recentId) ??
      roster.find((r) => r.threadId === origin) ??
      roster[0] ??
      null;
    const sourcePosts = yield* sql<{
      id: string;
      author_thread_id: string | null;
      text: string;
      created_at: string;
      reply_to_id: string | null;
    }>`SELECT id,json_extract(author_json,'$.threadId') AS author_thread_id,text,created_at,reply_to_id FROM board_posts WHERE root_id=${selection.rootId} AND id IN ${sql.in(selection.sourcePostIds)} ORDER BY created_at,id`;
    const evidencePosts = [
      ...sourcePosts,
      ...posts.filter((post) => !selection.sourcePostIds.includes(BoardPostId.make(post.id))),
    ];
    const contextKey = encodeJson([discussions, posts, sourcePosts, selection.sourcePostIds]);
    const rosterKey = encodeJson(roster);
    const context = encodeJson({
      context: (discussions[0]?.context_json ?? "").slice(0, 2000),
      sourcePostIds: selection.sourcePostIds,
      posts: evidencePosts
        .slice(0, 16)
        .reverse()
        .map((p) => ({
          id: p.id,
          author:
            p.author_thread_id === null
              ? "user"
              : `candidate-${roster.findIndex((candidate) => candidate.threadId === p.author_thread_id)}`,
          text: p.text.slice(0, 600),
        })),
    }).slice(0, 16_000);
    return { roster, fallback, contextKey, rosterKey, context };
  });
  const publish = Effect.fn("MessageBoardResponderSelection.publish")(function* (
    rootId: BoardPostId,
    acknowledgement: BoardPost | null,
  ) {
    yield* handling.publish(rootId);
    if (acknowledgement !== null)
      yield* PubSub.publish(events.changes, { type: "post-created", post: acknowledgement });
    yield* outbox.notifyAvailable();
  });
  const commit = Effect.fn("MessageBoardResponderSelection.commit")(function* (input: {
    selection: SelectionStore.Selection;
    recipientThreadId: ThreadId | null;
    method: "single" | "decisions" | "fallback";
    reason: string | null;
    contextFingerprint: string;
    rosterFingerprint: string;
    publishChanges?: boolean;
  }) {
    const now = yield* timestamp;
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* loadContext(input.selection);
        const contextFingerprint = yield* fingerprint(current.contextKey);
        const rosterFingerprint = yield* fingerprint(current.rosterKey);
        const stale =
          contextFingerprint !== input.contextFingerprint ||
          rosterFingerprint !== input.rosterFingerprint;
        const recipientThreadId = stale
          ? (current.fallback?.threadId ?? null)
          : input.recipientThreadId;
        const method = stale ? "fallback" : input.method;
        const reason =
          recipientThreadId === null
            ? (input.reason ?? "no-eligible")
            : stale
              ? "stale-context"
              : input.reason;
        const updated =
          yield* sql`UPDATE board_responder_selections SET status=${recipientThreadId ? "selected" : "unavailable"},recipient_thread_id=${recipientThreadId},method=${method},fallback_reason=${reason},context_fingerprint=${contextFingerprint},roster_fingerprint=${rosterFingerprint},updated_at=${now}
        WHERE id=${input.selection.id} AND generation=${input.selection.generation} AND status='selecting' RETURNING id`;
        if (updated.length === 0) return { changed: false, acknowledgement: null };
        let acknowledgement: BoardPost | null = null;
        if (recipientThreadId !== null) {
          for (const postId of input.selection.sourcePostIds) {
            yield* sql`INSERT INTO board_responsibilities(id,root_id,post_id,recipient_thread_id,selection_id,selection_generation,generation)
            VALUES(${`board-auto:${input.selection.id}:${postId}`},${input.selection.rootId},${postId},${recipientThreadId},${input.selection.id},${input.selection.generation},${input.selection.generation}) ON CONFLICT DO NOTHING`;
          }
          {
            const id = `board-selected:${input.selection.id}:${input.selection.generation}`;
            yield* outbox.enqueue([
              {
                id,
                commandId: CommandId.make(id),
                threadId: recipientThreadId,
                request: {
                  type: "board-dispatch",
                  rootId: input.selection.rootId,
                  recipientThreadId: recipientThreadId,
                },
              },
            ]);
          }
        } else {
          const roots = yield* sql<{
            channel_name: string;
            latest: string;
          }>`SELECT channel_name,(SELECT MAX(created_at) FROM board_posts WHERE root_id=${input.selection.rootId}) AS latest FROM board_posts WHERE id=${input.selection.rootId}`;
          const acknowledgementAt = DateTime.formatIso(
            DateTime.makeUnsafe(Math.max(Date.parse(now), Date.parse(roots[0]!.latest) + 1)),
          );
          acknowledgement = yield* decodePost({
            id: `board-availability:${input.selection.id}:${input.selection.generation}`,
            rootId: input.selection.rootId,
            channelName: roots[0]!.channel_name,
            author: { kind: "system" },
            text:
              reason === "no-eligible"
                ? "No eligible agent is available to reply to this message. The request remains unresolved."
                : "An automatic reply could not be scheduled. The request remains unresolved.",
            createdAt: acknowledgementAt,
          });
          yield* sql`INSERT INTO board_posts(id,root_id,channel_name,author_json,text,created_at) VALUES(${acknowledgement.id},${acknowledgement.rootId},${acknowledgement.channelName},${encodeJson({ kind: "system" })},${acknowledgement.text},${acknowledgementAt}) ON CONFLICT DO NOTHING`;
        }
        yield* handling.bump(input.selection.rootId);
        return { changed: true, acknowledgement };
      }),
    );
    if (result.changed && input.publishChanges !== false)
      yield* publish(input.selection.rootId, result.acknowledgement);
    return result;
  });
  return { sql, store, timestamp, loadContext, commit, publish, outbox, fingerprint };
});

export const makeExecutionGuard = Effect.gen(function* () {
  const { sql, store, timestamp, loadContext, commit, publish, outbox, fingerprint } =
    yield* makeShared;
  const reselectBeforeStart = Effect.fn("MessageBoardResponderSelection.reselectBeforeStart")(
    function* (input: BeforeStartInput) {
      const rows = yield* sql<{
        root_id: string;
        id: string;
      }>`SELECT DISTINCT r.root_id,s.id FROM board_responsibilities r JOIN board_responder_selections s ON s.id=r.selection_id WHERE r.batch_id=${input.batchId} AND r.recipient_thread_id=${input.threadId} AND s.started_at IS NULL`;
      if (rows.length === 0) return true;
      const invalid: Array<{
        selection: SelectionStore.Selection;
        context: Effect.Success<ReturnType<typeof loadContext>>;
      }> = [];
      for (const row of rows) {
        const selection = (yield* store.list(BoardPostId.make(row.root_id))).find(
          (s) => s.id === row.id,
        );
        if (selection === undefined || selection.status !== "selected") continue;
        const context = yield* loadContext(selection);
        if (!context.roster.some((candidate) => candidate.threadId === input.threadId))
          invalid.push({ selection, context });
      }
      if (invalid.length === 0) return true;
      const now = yield* timestamp;
      const changed = yield* sql.withTransaction(
        Effect.gen(function* () {
          const acknowledgements: Array<{ rootId: BoardPostId; post: BoardPost | null }> = [];
          for (const { selection } of invalid) {
            const matches =
              yield* sql`SELECT 1 FROM board_responder_selections WHERE id=${selection.id} AND generation=${selection.generation} AND started_at IS NULL`;
            if (matches.length === 0) return null;
          }
          for (const { selection, context } of invalid) {
            const replaced =
              yield* sql`UPDATE board_responder_selections SET status='selecting',generation=generation+1,recipient_thread_id=NULL,method=NULL,fallback_reason='reselected',attempt_count=1,call_started_at=NULL,updated_at=${now} WHERE id=${selection.id} AND generation=${selection.generation} AND started_at IS NULL RETURNING id`;
            if (replaced.length === 0) return null;
            yield* sql`DELETE FROM board_responsibilities WHERE selection_id=${selection.id} AND selection_generation=${selection.generation}`;
            const result = yield* commit({
              selection: { ...selection, generation: selection.generation + 1 },
              recipientThreadId: context.fallback?.threadId ?? null,
              method: "fallback",
              reason: context.fallback ? "reselected" : "no-eligible",
              contextFingerprint: yield* fingerprint(context.contextKey),
              rosterFingerprint: yield* fingerprint(context.rosterKey),
              publishChanges: false,
            });
            acknowledgements.push({ rootId: selection.rootId, post: result.acknowledgement });
          }
          yield* sql`UPDATE board_dispatch_batches SET status='superseded' WHERE id=${input.batchId}`;
          const remaining = yield* sql<{
            root_id: string;
            recipient_thread_id: string;
          }>`SELECT DISTINCT root_id,recipient_thread_id FROM board_responsibilities WHERE batch_id=${input.batchId} AND status IN ('queued','pending','running')`;
          yield* sql`UPDATE board_responsibilities SET status='pending',batch_id=NULL,run_id=NULL,generation=generation+1 WHERE batch_id=${input.batchId} AND status IN ('queued','pending','running')`;
          for (const request of remaining) {
            const id = `board-reselect-explicit:${input.batchId}:${request.recipient_thread_id}`;
            yield* outbox.enqueue([
              {
                id,
                commandId: CommandId.make(id),
                threadId: ThreadId.make(request.recipient_thread_id),
                request: {
                  type: "board-dispatch",
                  rootId: BoardPostId.make(request.root_id),
                  recipientThreadId: ThreadId.make(request.recipient_thread_id),
                },
              },
            ]);
          }
          return acknowledgements;
        }),
      );
      if (changed !== null) for (const { rootId, post } of changed) yield* publish(rootId, post);
      return false;
    },
    Effect.mapError(
      (cause) => new ResponderSelectionError({ operation: "reselectBeforeStart", cause }),
    ),
  );
  return { reselectBeforeStart };
});

export const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const { sql, store, timestamp, loadContext, commit, fingerprint } = yield* makeShared;
  const decisions = yield* Effect.serviceOption(Decisions.OpenAIDecisionsClient);
  const guard = yield* makeExecutionGuard;
  const select = Effect.fn("MessageBoardResponderSelection.select")(function* (
    selection: SelectionStore.Selection,
    recovery: boolean,
  ) {
    if (selection.status !== "selecting") return;
    const now = yield* timestamp;
    if (selection.attemptCount === 0) {
      if (!(yield* store.claim(selection.id, now))) return;
    } else if (!recovery) return;
    const initial = yield* loadContext(selection);
    let chosen = initial.fallback;
    let method: "single" | "decisions" | "fallback" =
      initial.roster.length === 1 ? "single" : "fallback";
    let reason: string | null = initial.roster.length === 0 ? "no-eligible" : null;
    if (selection.attemptCount > 0) reason = "interrupted";
    else if (now >= selection.deadlineAt) reason = "deadline";
    else if (initial.roster.length > 1) {
      if (Option.isNone(decisions)) reason = "missing-key";
      else if (
        yield* store.recordCallStarted({
          id: selection.id,
          generation: selection.generation,
          now,
          contextFingerprint: yield* fingerprint(initial.contextKey),
          rosterFingerprint: yield* fingerprint(initial.rosterKey),
        })
      ) {
        const result = yield* decisions.value
          .choose({
            candidates: initial.roster.map((candidate, index) => ({
              label: `candidate-${index}`,
              name: candidate.name,
              role: candidate.role,
            })),
            context: initial.context,
          })
          .pipe(
            Effect.timeoutOption(Math.max(1, Date.parse(selection.deadlineAt) - Date.parse(now))),
            Effect.orElseSucceed(() => Option.none()),
          );
        if (Option.isNone(result)) reason = "timeout";
        else if (result.value.kind === "fallback") reason = result.value.reason;
        else {
          const label = result.value.label;
          const index = initial.roster.findIndex((_, index) => `candidate-${index}` === label);
          chosen = initial.roster[index] ?? initial.fallback;
          method = index < 0 ? "fallback" : "decisions";
          reason = index < 0 ? "unknown-label" : null;
        }
      } else reason = "interrupted";
    }
    const current = yield* loadContext(selection);
    if (initial.contextKey !== current.contextKey || initial.rosterKey !== current.rosterKey) {
      chosen = current.fallback;
      method = "fallback";
      reason = "stale-context";
    }
    yield* commit({
      selection,
      recipientThreadId: chosen?.threadId ?? null,
      method,
      reason: chosen ? reason : "no-eligible",
      contextFingerprint: yield* fingerprint(current.contextKey),
      rosterFingerprint: yield* fingerprint(current.rosterKey),
    });
  });
  const run = Effect.fn("MessageBoardResponderSelection.run")(function* (
    rootId: BoardPostId | undefined,
    recovery: boolean,
  ) {
    for (let selection of yield* store.list(rootId)) {
      let recoverSelection = recovery;
      if (selection.status === "unavailable" && selection.startedAt === null) {
        const context = yield* loadContext(selection);
        if (context.fallback === null) continue;
        const changed =
          yield* sql`UPDATE board_responder_selections SET status='selecting',generation=generation+1,attempt_count=1,updated_at=${yield* timestamp}
          WHERE id=${selection.id} AND generation=${selection.generation} AND status='unavailable' AND started_at IS NULL RETURNING generation`;
        if (changed.length === 0) continue;
        selection = (yield* store.list(selection.rootId)).find((item) => item.id === selection.id)!;
        recoverSelection = true;
      }
      yield* select(selection, recoverSelection).pipe(
        Effect.catchCause(() =>
          Effect.gen(function* () {
            const current = (yield* store.list(selection.rootId)).find(
              (item) => item.id === selection.id,
            );
            if (current === undefined || current.status !== "selecting") return;
            const context = yield* loadContext(current);
            const fallback = {
              selection: current,
              recipientThreadId: context.fallback?.threadId ?? null,
              method: "fallback" as const,
              reason: "interrupted",
              contextFingerprint: yield* fingerprint(context.contextKey),
              rosterFingerprint: yield* fingerprint(context.rosterKey),
            };
            yield* commit(fallback).pipe(
              Effect.catch(() => commit({ ...fallback, recipientThreadId: null })),
            );
          }),
        ),
      );
    }
    return yield* store.list(rootId);
  });
  const activate = Effect.fn("MessageBoardResponderSelection.activate")(
    (rootId?: BoardPostId) =>
      run(rootId, false).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
    Effect.mapError((cause) => new ResponderSelectionError({ operation: "activate", cause })),
  );
  const recover = Effect.fn("MessageBoardResponderSelection.recover")(
    () => run(undefined, true),
    Effect.mapError((cause) => new ResponderSelectionError({ operation: "recover", cause })),
  );
  return MessageBoardResponderSelection.of({ activate, recover, ...guard });
});
export const layer = Layer.effect(MessageBoardResponderSelection, make);
