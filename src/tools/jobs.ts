/**
 * Jobs & workflows MCP tools.
 *
 * - `buzz_create_job` posts a kind:43001 `KIND_JOB_REQUEST` event.
 * - `buzz_approve_workflow` posts a kind:46030 (approve) or kind:46031 (deny)
 *   event with the workflow id as an `e`-tag reference.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SignedFetchResult } from "../relay/client.js";
import { buildJob, buildWorkflowApproval } from "../relay/event-builder.js";
import type { NsecOrHex } from "../relay/signer.js";
import { signedFetchWithTimeout } from "../util/relay-call.js";

const RELAY_BODY_PRINT_LIMIT = 1_000;

/**
 * Register `buzz_create_job`. POSTs a kind:43001 event to `/events`.
 *
 * NOTE: the Rust SDK doesn't ship a `build_create_job` helper yet. The kind
 * (43001) is canonical (`CorePrt-relay/crates/buzz-core/src/kind.rs:458`,
 * `KIND_JOB_REQUEST`). The tag shape is a reasonable v1 placeholder; if the
 * relay rejects it we'll switch to whatever the SDK eventually emits.
 */
export function registerCreateJobTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
): void {
  server.tool(
    "buzz_create_job",
    "Create a job (kind:43001 KIND_JOB_REQUEST). Returns the event id and the " +
      'job payload. Budget is embedded as `["amount", …]` and due-at as ' +
      '`["due", …]`.',
    {
      title: z.string().min(1).max(200).describe("Job title. Required."),
      description: z
        .string()
        .min(1)
        .max(32 * 1024)
        .describe("Job description (event content). Required."),
      budget: z.number().int().nonnegative().optional().describe("Optional budget (numeric)."),
      dueAt: z.iso.datetime().optional().describe("Optional due-at (ISO-8601 timestamp string)."),
    },
    async (args) => {
      const event = await buildJob({
        secret,
        title: args.title,
        description: args.description,
        budget: args.budget,
        dueAt: args.dueAt,
      });

      let resp: SignedFetchResult;
      try {
        resp = await signedFetchWithTimeout(secret, {
          method: "POST",
          url: `${relayUrl.replace(/\/$/, "")}/events`,
          body: JSON.stringify(event),
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        throw new Error(`relay at ${relayUrl} did not respond: ${(err as Error).message}`);
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          `relay rejected event: HTTP ${resp.status} — ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                event_id: event.id,
                accepted: true,
                job: {
                  title: args.title,
                  description: args.description,
                  budget: args.budget ?? null,
                  dueAt: args.dueAt ?? null,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

/**
 * Register `buzz_approve_workflow`. POSTs kind 46030 (approve) or 46031
 * (reject) to `/events`. References the workflow being approved via an
 * `["e", workflowId]` tag.
 *
 * NOTE: the Rust SDK's `build_workflow_approval`
 * (`CorePrt-relay/crates/buzz-sdk/src/builders.rs:1522`) keys off
 * `["d", token_hash]` (sha256 hex of an approval-token UUID) for a
 * parameterized-replaceable event. For the MCP surface we accept a plain
 * `workflowId` and use `["e", …]` instead — when the SDK canonical shape
 * lands we'll switch.
 */
export function registerApproveWorkflowTool(
  server: McpServer,
  secret: NsecOrHex,
  relayUrl: string,
): void {
  server.tool(
    "buzz_approve_workflow",
    "Approve or reject a workflow (kind:46030 grant or kind:46031 deny). " +
      "Returns the event id, the decision, and the workflow id.",
    {
      workflowId: z
        .string()
        .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters")
        .describe("Workflow id (64-char hex event id). Required."),
      decision: z
        .enum(["approve", "reject"])
        .default("approve")
        .describe('Approval decision (default "approve").'),
      comment: z
        .string()
        .max(2048)
        .optional()
        .describe("Optional human-readable note (event content)."),
    },
    async (args) => {
      const event = await buildWorkflowApproval({
        secret,
        workflowId: args.workflowId,
        decision: args.decision,
        comment: args.comment,
      });

      let resp: SignedFetchResult;
      try {
        resp = await signedFetchWithTimeout(secret, {
          method: "POST",
          url: `${relayUrl.replace(/\/$/, "")}/events`,
          body: JSON.stringify(event),
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        throw new Error(`relay at ${relayUrl} did not respond: ${(err as Error).message}`);
      }

      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(
          `relay rejected event: HTTP ${resp.status} — ${resp.bodyText.slice(0, RELAY_BODY_PRINT_LIMIT)}`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                event_id: event.id,
                accepted: true,
                workflow: {
                  id: args.workflowId,
                  decision: args.decision,
                  comment: args.comment ?? null,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
