import { z } from "zod";

export interface McpToolDef {
  /** The name agents see, e.g. `mp_status`. */
  name: string;
  /** The daemon tool it maps to, e.g. `status`. */
  daemonTool: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  readOnly: boolean;
}

const stepStatus = z.enum(["pending", "active", "done", "skipped"]);
const agentId = z.string().min(1).describe("The other agent's id, as shown by mp_status.");

/**
 * The tools agents see. Descriptions are written for the model: they say when to use each tool,
 * because that's how agents learn to coordinate instead of colliding.
 */
export const TOOLS: McpToolDef[] = [
  {
    name: "mp_status",
    daemonTool: "status",
    title: "What is everyone doing?",
    description:
      "See what every agent in this multiplayer room is doing right now: owner and vendor (Claude or Codex), current task, " +
      "plan progress, claimed directories, files being modified, and conflicts. Call it when you start a task, before you touch " +
      "shared areas, and whenever your user asks what others are doing.",
    inputSchema: {},
    readOnly: true,
  },
  {
    name: "mp_agent",
    daemonTool: "agent",
    title: "Another agent's record",
    description:
      "Get one agent's full record without interrupting it: its plan with step status, claims, locked and changed files, and recent " +
      "activity. Use this first when your user asks about another agent's work. Use mp_ask only if the record doesn't answer the question.",
    inputSchema: { agentId },
    readOnly: true,
  },
  {
    name: "mp_plan",
    daemonTool: "plan",
    title: "Publish your plan",
    description:
      "Publish your plan to the room. Required before your first edit: edits are blocked until you do. Give a short title, a " +
      "one-paragraph summary, concrete steps, and the paths or globs you expect to touch. Publishing again replaces the plan, so " +
      "republish when your approach changes.",
    inputSchema: {
      title: z.string().min(1).max(200).describe("Short name for the work, e.g. 'Auth refactor'."),
      summary: z.string().max(4000).optional().describe("One paragraph: what you're changing and why."),
      steps: z
        .array(
          z.union([
            z.string().min(1).max(500),
            z.object({ id: z.string().optional(), text: z.string().min(1).max(500), status: stepStatus.optional() }),
          ]),
        )
        .max(50)
        .describe("Ordered steps. Plain strings get ids s1, s2, …"),
      paths: z.array(z.string().min(1)).max(100).optional().describe("Repo-relative paths or globs you expect to touch."),
    },
    readOnly: false,
  },
  {
    name: "mp_update_plan",
    daemonTool: "update_plan",
    title: "Update a plan step",
    description: "Mark a step of your plan pending, active, done or skipped as you work, so others see your progress. Keep one step active.",
    inputSchema: {
      stepId: z.string().min(1).describe("Step id, e.g. s2."),
      status: stepStatus,
    },
    readOnly: false,
  },
  {
    name: "mp_claim",
    daemonTool: "claim",
    title: "Claim an area",
    description:
      "Claim a directory or glob you will own for this task, e.g. src/billing/**. Claims are advisory: others are warned when they " +
      "enter your area, and you're told if your claim overlaps someone else's. Claim narrowly.",
    inputSchema: {
      pattern: z.string().min(1).describe("Repo-relative directory or glob."),
      reason: z.string().max(500).optional().describe("Why you need it, shown to others."),
    },
    readOnly: false,
  },
  {
    name: "mp_release",
    daemonTool: "release",
    title: "Release a claim",
    description: "Release one of your claims by pattern, or all of them when no pattern is given. Release areas as soon as you're done with them.",
    inputSchema: { pattern: z.string().min(1).optional() },
    readOnly: false,
  },
  {
    name: "mp_message",
    daemonTool: "message",
    title: "Message the room",
    description:
      'Send a message to another agent (by id or name), a teammate (member id), or "room" for everyone. Use kind "question" when ' +
      'you need an answer (or mp_ask to wait for it), "fyi" for heads-ups like "I\'m changing the User type", and "handoff" to ask ' +
      "someone to make a change in their area.",
    inputSchema: {
      to: z.union([z.string().min(1), z.array(z.string().min(1))]).describe('Agent id or name, member id, or "room". Can be a list.'),
      body: z.string().min(1).max(16_000),
      kind: z.enum(["chat", "fyi", "question", "handoff"]).optional(),
      urgent: z.boolean().optional().describe("Also deliver room-wide messages to every agent."),
      threadId: z.string().optional().describe("Continue an existing thread."),
    },
    readOnly: false,
  },
  {
    name: "mp_answer",
    daemonTool: "answer",
    title: "Answer a message",
    description: "Reply to a question or handoff you received from another agent. Pass the message id shown with the message.",
    inputSchema: {
      messageId: z.string().min(1),
      body: z.string().min(1).max(16_000),
    },
    readOnly: false,
  },
  {
    name: "mp_inbox",
    daemonTool: "inbox",
    title: "Check messages",
    description: "Fetch messages addressed to you that you haven't seen yet. New messages are also shown to you automatically as they arrive.",
    inputSchema: {},
    readOnly: false,
  },
  {
    name: "mp_who_touches",
    daemonTool: "who_touches",
    title: "Who touches this path?",
    description:
      "Before changing a file or directory, check who else is involved with it: locks, claims, live changes, plans and collisions. " +
      "Especially useful for shared files like types, schemas, config and routes.",
    inputSchema: { path: z.string().min(1).describe("Repo-relative file, directory or glob.") },
    readOnly: true,
  },
  {
    name: "mp_ask",
    daemonTool: "ask",
    title: "Ask another agent",
    description:
      "Ask another agent a question and wait for its answer (up to waitSeconds, default 60). The other agent answers from its own " +
      "context, so use this for intent, timing and coordination (\"are you about to change the User type?\"). For facts already in its " +
      "record, use mp_agent instead, which doesn't interrupt it.",
    inputSchema: {
      agentId,
      question: z.string().min(1).max(16_000),
      waitSeconds: z.number().min(0).max(120).optional(),
    },
    readOnly: false,
  },
  {
    name: "mp_handoff",
    daemonTool: "handoff",
    title: "Hand off a change",
    description:
      "Ask the agent that owns an area, or holds a lock on a file, to make a change for you instead of editing their files. Say " +
      "exactly what you need and why. They reply with mp_answer.",
    inputSchema: { agentId, request: z.string().min(1).max(16_000) },
    readOnly: false,
  },
];
