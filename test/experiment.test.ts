import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatSummary,
  parseCsv,
  readAnswers,
  readEffort,
  summarize,
  type Answer,
  type Effort,
} from "../src/experiment.ts";

function answer(
  participant: string,
  question: string,
  condition: Answer["condition"],
  minutes: number,
  extra: Partial<Answer> = {},
): Answer {
  return {
    participant,
    question,
    condition,
    minutes,
    score: 1,
    confidence: 4,
    usedRetired: false,
    expectedMemoryReturned: null,
    ...extra,
  };
}

// Two questions, each answered once per condition: MemoryNet saves 6 minutes on each.
const CROSSOVER: Answer[] = [
  answer("P1", "Q1", "baseline", 10),
  answer("P2", "Q2", "baseline", 8),
  answer("P2", "Q1", "memorynet", 4, { expectedMemoryReturned: true }),
  answer("P1", "Q2", "memorynet", 2, { expectedMemoryReturned: false }),
];
const EFFORT: Effort[] = [
  { activity: "evidence", minutes: 10 },
  { activity: "writing", minutes: 15 },
  { activity: "writing", minutes: 5 },
  { activity: "review", minutes: 6 },
  { activity: "baseline_setup", minutes: 15 },
];

test("CSV rows are read by header, with quoted commas, quotes, and line breaks", () => {
  const rows = parseCsv(
    'Participant,Question,Answer\r\nP1,Q1,"Kept, because ""cache"" helps\nlatency"\r\n\r\nP2,Q2,plain\n',
  );
  assert.deepEqual(rows, [
    {
      participant: "P1",
      question: "Q1",
      answer: 'Kept, because "cache" helps\nlatency',
    },
    { participant: "P2", question: "Q2", answer: "plain" },
  ]);
  assert.deepEqual(parseCsv(""), []);
});

test("faster, at least as correct, and repaid within the expected lookups means continue", () => {
  const summary = summarize(CROSSOVER, EFFORT, 10);
  assert.equal(summary.pairedQuestions, 2);
  assert.equal(summary.savingPerLookup, 6);
  assert.equal(summary.minutesSaved, 12);
  assert.equal(
    summary.curationMinutes,
    36,
    "evidence, writing, review, and upkeep count; baseline setup does not",
  );
  assert.equal(summary.effort.baseline_setup, 15);
  assert.equal(summary.net, -24, "the sessions alone do not repay curation");
  assert.equal(summary.breakEvenLookups, 6);
  assert.deepEqual(summary.retrieval, { known: 2, returned: 1 });
  assert.equal(summary.decision, "continue");

  assert.equal(summarize(CROSSOVER, EFFORT, 5).decision, "narrow");
  assert.equal(summarize(CROSSOVER, EFFORT, null).decision, "incomplete");
});

test("being faster does not count when answers get worse or follow retired guidance", () => {
  const worse = CROSSOVER.map((item) =>
    item.condition === "memorynet" && item.question === "Q1"
      ? { ...item, score: 0.5 }
      : item,
  );
  const lessCorrect = summarize(worse, EFFORT, 100);
  assert.equal(lessCorrect.decision, "stop");
  assert.match(lessCorrect.reasons.join(" "), /less correct/);

  const confident = CROSSOVER.map((item) =>
    item.condition === "memorynet" && item.question === "Q2"
      ? { ...item, score: 0, confidence: 5 }
      : item,
  );
  assert.match(
    summarize(confident, EFFORT, 100).reasons.join(" "),
    /Confidently wrong/,
  );

  const retired = CROSSOVER.map((item) =>
    item.condition === "memorynet" ? { ...item, usedRetired: true } : item,
  );
  const outcome = summarize(retired, EFFORT, 100);
  assert.equal(outcome.decision, "stop");
  assert.match(outcome.reasons.join(" "), /retired guidance/);
});

test("not faster means stop, and no question answered both ways means incomplete", () => {
  const slower = CROSSOVER.map((item) =>
    item.condition === "memorynet" ? { ...item, minutes: 12 } : item,
  );
  const outcome = summarize(slower, EFFORT, 100);
  assert.equal(outcome.decision, "stop");
  assert.equal(outcome.breakEvenLookups, null);
  assert.match(outcome.reasons.join(" "), /not faster/);

  const unpaired = summarize(
    [answer("P1", "Q1", "baseline", 5), answer("P1", "Q2", "memorynet", 2)],
    EFFORT,
    100,
  );
  assert.equal(unpaired.decision, "incomplete");
  assert.equal(unpaired.savingPerLookup, null);
});

test("facilitator files are checked row by row", () => {
  const rows = parseCsv(
    [
      "participant,question,condition,minutes,score,confidence,used_retired_as_current,expected_memory_returned",
      "P1,Q1,memorynet,3.5,0.5,2,no,yes",
    ].join("\n"),
  );
  assert.deepEqual(readAnswers(rows), [
    {
      participant: "P1",
      question: "Q1",
      condition: "memorynet",
      minutes: 3.5,
      score: 0.5,
      confidence: 2,
      usedRetired: false,
      expectedMemoryReturned: true,
    },
  ]);
  for (const [field, value, message] of [
    ["condition", "both", /row 1: condition/],
    ["score", "0.7", /row 1: score/],
    ["minutes", "", /row 1: minutes/],
    ["confidence", "9", /row 1: confidence/],
    ["used_retired_as_current", "maybe", /row 1: used_retired_as_current/],
  ] as const) {
    assert.throws(() => readAnswers([{ ...rows[0], [field]: value }]), message);
  }
  assert.deepEqual(readEffort([{ activity: "Review", minutes: "4" }]), [
    { activity: "review", minutes: 4 },
  ]);
  assert.throws(
    () => readEffort([{ activity: "coffee", minutes: "4" }]),
    /row 1: activity/,
  );
});

test("the printed summary states the numbers and the decision", () => {
  const text = formatSummary(summarize(CROSSOVER, EFFORT, 10));
  assert.match(text, /Saving per lookup: 6\.0 minutes/);
  assert.match(
    text,
    /= 36\.0 minutes \(baseline setup 15\.0, not subtracted\)/,
  );
  assert.match(
    text,
    /Break-even: 6\.0 lookups like these; the team expected 10/,
  );
  assert.match(text, /Expected memory returned by search: 1 of 2/);
  assert.match(text, /Decision: continue/);
});
