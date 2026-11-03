import type { ScopeLevel } from "../access.ts";
import type { DefinitionKind } from "../definitions.ts";
import type { MemoryType } from "../knowledge.ts";
import type { EdgeRelation, NodeKind } from "../network.ts";
import { PROMPT_BLOCK_TITLES, type PromptBlockKey } from "../prompt.ts";
import type { NodeState } from "./assets/network-view.js";

/** What each block of an assembled prompt is for, in a few words. */
export const PROMPT_BLOCK_INFO: Readonly<
  Record<PromptBlockKey, { label: string; meaning: string }>
> = {
  role: {
    label: PROMPT_BLOCK_TITLES.role,
    meaning: "who the AI is, and who it works for",
  },
  objective: {
    label: PROMPT_BLOCK_TITLES.objective,
    meaning: "the goal, and how to reach it",
  },
  context: {
    label: PROMPT_BLOCK_TITLES.context,
    meaning: "the approved knowledge it needs",
  },
  rules: {
    label: PROMPT_BLOCK_TITLES.rules,
    meaning: "the rules it follows, and its limits",
  },
  output: {
    label: PROMPT_BLOCK_TITLES.output,
    meaning: "how to answer: cite, stay honest, only propose",
  },
  review: {
    label: PROMPT_BLOCK_TITLES.review,
    meaning: "a self-check before it finishes",
  },
  start: {
    label: PROMPT_BLOCK_TITLES.start,
    meaning: "when to begin",
  },
};

export interface KindInfo {
  label: string;
  plural: string;
  /** What this kind of definition is, in one or two sentences. */
  meaning: string;
  /** Heading for the responsibilities list. */
  duties: string;
  /** Heading for the boundaries list. */
  limits: string;
}

export const KIND_INFO: Readonly<Record<DefinitionKind, KindInfo>> = {
  agent: {
    label: "Agent",
    plural: "Agents",
    meaning:
      "An AI assistant's job: what it is responsible for, which skills it uses, which rules it follows, and what it must never do. MemoryNet describes it; it never runs it.",
    duties: "Responsibilities",
    limits: "Must never",
  },
  skill: {
    label: "Skill",
    plural: "Skills",
    meaning:
      "A repeatable procedure that agents or people use for one kind of task.",
    duties: "What it does",
    limits: "Not for",
  },
  instruction: {
    label: "Instruction",
    plural: "Instructions",
    meaning: "Guidance that people and AI tools follow while they work here.",
    duties: "What it asks for",
    limits: "Does not cover",
  },
  rule: {
    label: "Rule",
    plural: "Rules",
    meaning:
      "A requirement that must hold here. Agents, skills, and instructions follow it.",
    duties: "What it requires",
    limits: "Does not apply to",
  },
};

export const NODE_INFO: Readonly<
  Record<NodeKind, { label: string; meaning: string }>
> = {
  rule: { label: "Rule", meaning: KIND_INFO.rule.meaning },
  instruction: { label: "Instruction", meaning: KIND_INFO.instruction.meaning },
  skill: { label: "Skill", meaning: KIND_INFO.skill.meaning },
  agent: { label: "Agent", meaning: KIND_INFO.agent.meaning },
  memory: {
    label: "Memory",
    meaning:
      "Approved knowledge at its current version: a decision, reason, constraint, lesson, failed approach, or incident.",
  },
  source: {
    label: "Source",
    meaning: "Pull request evidence that an approved memory cites.",
  },
  person: {
    label: "Person",
    meaning: "Someone accountable for memories or definitions shown here.",
  },
  agent_account: {
    label: "Agent account",
    meaning:
      "An AI agent's MemoryNet account. It can hold only the reader or contributor role: it can read and propose, never approve.",
  },
};

export const RELATION_INFO: Readonly<
  Record<EdgeRelation, { label: string; meaning: string }>
> = {
  uses: {
    label: "uses",
    meaning:
      "Agent or skill → skill. Calls on that skill for part of its work.",
  },
  follows: {
    label: "follows",
    meaning: "Definition → rule or instruction. Must obey it.",
  },
  hands_off_to: {
    label: "hands off to",
    meaning: "Agent → agent. Passes the work on when it reaches its limits.",
  },
  based_on: {
    label: "based on",
    meaning:
      "Definition → memory. Its guidance comes from this approved knowledge.",
  },
  runs_as: {
    label: "runs as",
    meaning:
      "Agent → agent account. The account whose roles limit what the agent may read and propose.",
  },
  cites: {
    label: "cites",
    meaning: "Memory → source. The pull request evidence behind the memory.",
  },
  owns: {
    label: "owns",
    meaning:
      "Person → memory or definition. Accountable for keeping it correct.",
  },
};

export const LEVEL_INFO: Readonly<
  Record<ScopeLevel, { label: string; meaning: string }>
> = {
  organization: {
    label: "Organization",
    meaning:
      "The outer group. Its rules and instructions reach every business unit and project inside.",
  },
  business_unit: {
    label: "Business unit",
    meaning:
      "A group of projects. Its definitions reach the projects inside it, never other business units.",
  },
  project: {
    label: "Project",
    meaning:
      "Where memories and their sources live. Its definitions stay inside the project.",
  },
};

export const MEMORY_TYPE_INFO: Readonly<
  Record<MemoryType, { label: string; meaning: string }>
> = {
  decision: { label: "Decision", meaning: "A choice the team made." },
  rationale: { label: "Rationale", meaning: "The reason behind a choice." },
  constraint: {
    label: "Constraint",
    meaning: "A limit the work must stay within.",
  },
  lesson: {
    label: "Lesson",
    meaning: "Something learned that should carry forward.",
  },
  failed_approach: {
    label: "Failed approach",
    meaning: "Something tried that did not work, and why.",
  },
  incident: { label: "Incident", meaning: "Something that went wrong in use." },
};

/** Display states. Suspended, replaced, and conflict arrive with memory history (Feature 5). */
export const STATE_INFO: Readonly<
  Record<NodeState, { label: string; meaning: string }>
> = {
  current: { label: "Current", meaning: "The version in use now." },
  pending: {
    label: "Change waiting",
    meaning: "A proposed change waits for a different reviewer.",
  },
  retired: {
    label: "Retired",
    meaning: "Kept for its history. Nothing should rely on it now.",
  },
  warning: {
    label: "Needs a look",
    meaning:
      "It links to something retired, or its agent account cannot read here.",
  },
  flagged: {
    label: "Flagged",
    meaning:
      "Its text may hold personal data, or a secret was removed from it.",
  },
};
