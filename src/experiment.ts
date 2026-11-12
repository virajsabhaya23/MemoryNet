// Pre-registered analysis for the decision-reuse experiment.
// Pure functions over the facilitator's answers.csv and effort.csv; nothing here reads the database.

export const CONDITIONS = ["baseline", "memorynet"] as const;
export type Condition = (typeof CONDITIONS)[number];

/** evidence: recording pull requests. upkeep: suspending or replacing memories. baseline_setup: preparing the existing workflow, such as a shared knowledge space. */
export const EFFORT_ACTIVITIES = [
  "evidence",
  "writing",
  "review",
  "upkeep",
  "baseline_setup",
] as const;
export type EffortActivity = (typeof EFFORT_ACTIVITIES)[number];

export interface Answer {
  participant: string;
  question: string;
  condition: Condition;
  minutes: number;
  /** Graded against the answer key: 1 correct, 0.5 partly correct, 0 wrong or no answer. */
  score: number;
  /** 1 (a guess) to 5 (certain); null when not asked. */
  confidence: number | null;
  /** The answer treated suspended or replaced guidance as current. */
  usedRetired: boolean;
  /** MemoryNet answers: whether the search log shows the expected memory was returned. */
  expectedMemoryReturned: boolean | null;
}

export interface Effort {
  activity: EffortActivity;
  minutes: number;
}

export type Decision = "continue" | "narrow" | "stop" | "incomplete";

export interface Summary {
  participants: number;
  questions: number;
  /** Questions answered in both conditions; only these compare times. */
  pairedQuestions: number;
  answers: Record<Condition, number>;
  meanScore: Record<Condition, number | null>;
  medianMinutes: Record<Condition, number | null>;
  minutesPerCorrectAnswer: Record<Condition, number | null>;
  /** Wrong (score 0) with confidence 4 or 5. */
  confidentlyWrong: Record<Condition, number>;
  usedRetired: Record<Condition, number>;
  retrieval: { known: number; returned: number };
  /** Mean over paired questions of (baseline mean minutes - MemoryNet mean minutes). */
  savingPerLookup: number | null;
  /** Each MemoryNet answer's question's baseline mean minus its own minutes, summed over paired questions. */
  minutesSaved: number;
  effort: Record<EffortActivity, number>;
  /** Evidence, writing, review, and upkeep. Baseline setup is reported but not subtracted: both conditions keep the existing workflow. */
  curationMinutes: number;
  net: number;
  breakEvenLookups: number | null;
  expectedLookups: number | null;
  decision: Decision;
  reasons: string[];
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function perCondition<T>(
  make: (condition: Condition) => T,
): Record<Condition, T> {
  return { baseline: make("baseline"), memorynet: make("memorynet") };
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

export function summarize(
  answers: readonly Answer[],
  effort: readonly Effort[],
  expectedLookups: number | null,
): Summary {
  const of = (condition: Condition) =>
    answers.filter((answer) => answer.condition === condition);
  const counts = perCondition((condition) => of(condition).length);
  const confidentlyWrong = perCondition(
    (condition) =>
      of(condition).filter(
        (answer) => answer.score === 0 && (answer.confidence ?? 0) >= 4,
      ).length,
  );
  const usedRetired = perCondition(
    (condition) => of(condition).filter((answer) => answer.usedRetired).length,
  );
  const meanScore = perCondition((condition) =>
    mean(of(condition).map((answer) => answer.score)),
  );
  const minutesPerCorrectAnswer = perCondition((condition) => {
    const score = of(condition).reduce((sum, answer) => sum + answer.score, 0);
    const minutes = of(condition).reduce((sum, a) => sum + a.minutes, 0);
    return score === 0 ? null : minutes / score;
  });

  const questions = [...new Set(answers.map((answer) => answer.question))];
  const savings: number[] = [];
  let minutesSaved = 0;
  for (const question of questions) {
    const times = perCondition((condition) =>
      of(condition)
        .filter((answer) => answer.question === question)
        .map((answer) => answer.minutes),
    );
    const baseline = mean(times.baseline);
    const memorynet = mean(times.memorynet);
    if (baseline === null || memorynet === null) continue;
    savings.push(baseline - memorynet);
    minutesSaved += times.memorynet.reduce(
      (sum, minutes) => sum + (baseline - minutes),
      0,
    );
  }
  const savingPerLookup = mean(savings);

  const totals = Object.fromEntries(
    EFFORT_ACTIVITIES.map((activity) => [
      activity,
      effort
        .filter((item) => item.activity === activity)
        .reduce((sum, item) => sum + item.minutes, 0),
    ]),
  ) as Record<EffortActivity, number>;
  const curationMinutes =
    totals.evidence + totals.writing + totals.review + totals.upkeep;
  const breakEvenLookups =
    savingPerLookup !== null && savingPerLookup > 0
      ? curationMinutes / savingPerLookup
      : null;
  const known = of("memorynet").filter(
    (answer) => answer.expectedMemoryReturned !== null,
  );

  const reasons: string[] = [];
  let decision: Decision;
  if (savings.length === 0) {
    decision = "incomplete";
    reasons.push("No question was answered in both conditions.");
  } else {
    const scores = meanScore as Record<Condition, number>;
    if (scores.memorynet < scores.baseline) {
      reasons.push("Answers were less correct with MemoryNet.");
    }
    if (
      rate(confidentlyWrong.memorynet, counts.memorynet) >
      rate(confidentlyWrong.baseline, counts.baseline)
    ) {
      reasons.push(
        "Confidently wrong answers were more common with MemoryNet.",
      );
    }
    if (usedRetired.memorynet > 0) {
      reasons.push(
        "At least one MemoryNet answer treated retired guidance as current.",
      );
    }
    if ((savingPerLookup ?? 0) <= 0) {
      reasons.push("Answers were not faster with MemoryNet.");
    }
    if (reasons.length > 0) {
      decision = "stop";
    } else if (expectedLookups === null) {
      decision = "incomplete";
      reasons.push(
        "Faster and at least as correct, but the team's expected lookups were not recorded before the sessions.",
      );
    } else if ((breakEvenLookups ?? Infinity) <= expectedLookups) {
      decision = "continue";
      reasons.push(
        "Faster, at least as correct, and the curation time is repaid within the lookups the team expects.",
      );
    } else {
      decision = "narrow";
      reasons.push(
        "Faster and at least as correct, but the curation time is not repaid within the lookups the team expects.",
      );
    }
  }

  return {
    participants: new Set(answers.map((answer) => answer.participant)).size,
    questions: questions.length,
    pairedQuestions: savings.length,
    answers: counts,
    meanScore,
    medianMinutes: perCondition((condition) =>
      median(of(condition).map((answer) => answer.minutes)),
    ),
    minutesPerCorrectAnswer,
    confidentlyWrong,
    usedRetired,
    retrieval: {
      known: known.length,
      returned: known.filter((answer) => answer.expectedMemoryReturned).length,
    },
    savingPerLookup,
    minutesSaved,
    effort: totals,
    curationMinutes,
    net: minutesSaved - curationMinutes,
    breakEvenLookups,
    expectedLookups,
    decision,
    reasons,
  };
}

/** Rows of a CSV file with a header line, keyed by the header names. Quoted fields may hold commas, quotes, and line breaks. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [header, ...rows] = records.filter((row) =>
    row.some((value) => value.trim() !== ""),
  );
  if (!header) return [];
  const names = header.map((name) => name.trim().toLowerCase());
  return rows.map((row) =>
    Object.fromEntries(
      names.map((name, column) => [name, (row[column] ?? "").trim()]),
    ),
  );
}

function fail(file: string, line: number, message: string): never {
  throw new Error(`${file} row ${line}: ${message}`);
}

function number(
  value: string | undefined,
  file: string,
  line: number,
  column: string,
): number {
  const parsed = Number(value);
  if (
    value === undefined ||
    value === "" ||
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    fail(file, line, `${column} must be a number of 0 or more`);
  }
  return parsed;
}

function yesNo(
  value: string | undefined,
  file: string,
  line: number,
  column: string,
): boolean | null {
  const text = (value ?? "").toLowerCase();
  if (text === "") return null;
  if (text === "yes") return true;
  if (text === "no") return false;
  return fail(file, line, `${column} must be yes, no, or empty`);
}

/** answers.csv rows; row numbers count data rows from 1. */
export function readAnswers(
  rows: ReadonlyArray<Record<string, string>>,
  file = "answers.csv",
): Answer[] {
  return rows.map((row, index) => {
    const line = index + 1;
    const condition = row.condition?.toLowerCase();
    if (!CONDITIONS.some((item) => item === condition)) {
      fail(file, line, "condition must be baseline or memorynet");
    }
    const score = number(row.score, file, line, "score");
    if (![0, 0.5, 1].includes(score)) {
      fail(file, line, "score must be 0, 0.5, or 1");
    }
    const confidence =
      row.confidence === undefined || row.confidence === ""
        ? null
        : number(row.confidence, file, line, "confidence");
    if (confidence !== null && ![1, 2, 3, 4, 5].includes(confidence)) {
      fail(file, line, "confidence must be 1 to 5, or empty");
    }
    if (!row.participant || !row.question) {
      fail(file, line, "participant and question are required");
    }
    return {
      participant: row.participant,
      question: row.question,
      condition: condition as Condition,
      minutes: number(row.minutes, file, line, "minutes"),
      score,
      confidence,
      usedRetired:
        yesNo(
          row.used_retired_as_current,
          file,
          line,
          "used_retired_as_current",
        ) ?? false,
      expectedMemoryReturned: yesNo(
        row.expected_memory_returned,
        file,
        line,
        "expected_memory_returned",
      ),
    };
  });
}

export function readEffort(
  rows: ReadonlyArray<Record<string, string>>,
  file = "effort.csv",
): Effort[] {
  return rows.map((row, index) => {
    const line = index + 1;
    const activity = row.activity?.toLowerCase();
    if (!EFFORT_ACTIVITIES.some((item) => item === activity)) {
      fail(
        file,
        line,
        `activity must be one of: ${EFFORT_ACTIVITIES.join(", ")}`,
      );
    }
    return {
      activity: activity as EffortActivity,
      minutes: number(row.minutes, file, line, "minutes"),
    };
  });
}

function show(value: number | null, digits = 1): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

/** The summary as plain text, for the development plan's result. */
export function formatSummary(summary: Summary): string {
  const both = (
    label: string,
    values: Record<Condition, number | null>,
    digits = 1,
  ) =>
    `${label}: baseline ${show(values.baseline, digits)} · MemoryNet ${show(values.memorynet, digits)}`;
  const { effort, retrieval } = summary;
  return [
    "Decision-reuse experiment summary",
    "",
    `Answers: ${summary.answers.baseline} baseline, ${summary.answers.memorynet} MemoryNet · ${summary.participants} participants · ${summary.questions} questions (${summary.pairedQuestions} answered in both conditions)`,
    both("Correctness (mean score, 1 = correct)", summary.meanScore, 2),
    both("Median minutes per answer", summary.medianMinutes),
    both("Minutes per correct answer", summary.minutesPerCorrectAnswer),
    both("Confidently wrong answers", summary.confidentlyWrong, 0),
    both("Retired guidance used as current", summary.usedRetired, 0),
    `Expected memory returned by search: ${retrieval.known === 0 ? "not recorded" : `${retrieval.returned} of ${retrieval.known} MemoryNet answers`}`,
    "",
    `Saving per lookup: ${show(summary.savingPerLookup)} minutes (mean over ${summary.pairedQuestions} questions)`,
    `Minutes saved in the sessions: ${show(summary.minutesSaved)}`,
    `Curation: evidence ${show(effort.evidence)} + writing ${show(effort.writing)} + review ${show(effort.review)} + upkeep ${show(effort.upkeep)} = ${show(summary.curationMinutes)} minutes (baseline setup ${show(effort.baseline_setup)}, not subtracted)`,
    `Net in the sessions: ${show(summary.net)} minutes`,
    `Break-even: ${summary.breakEvenLookups === null ? "never, at these times" : `${show(summary.breakEvenLookups)} lookups like these`}; the team expected ${summary.expectedLookups === null ? "(not recorded)" : summary.expectedLookups}`,
    "",
    `Decision: ${summary.decision}`,
    ...summary.reasons.map((reason) => `- ${reason}`),
  ].join("\n");
}
