import { ValidationError } from "../errors.ts";

/** Offline scorer only: it never runs an agent, oracle command, model or network request. */
export interface RunPlan {
  protocolSha256: string;
  datasetSha256: string;
  tasks: Array<{ id: string; familyId: string }>;
  methods: string[];
  seeds: number[];
}

export interface RecordedRun {
  taskId: string;
  method: string;
  seed: number;
  protocolSha256: string;
  datasetSha256: string;
  /** Hash of a retained raw run bundle, including oracle output and produced artifact. */
  artifactSha256: string;
  status: "completed" | "infrastructure_failure" | "model_failure" | "timeout" | "refusal";
  /** Deterministic hidden-oracle outcome; not the agent's own success assertion. */
  oraclePassed: boolean | null;
  staleAuthorityUsed: boolean | null;
  unauthorizedAuthorityDelivered: boolean | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const STATUSES = ["completed", "infrastructure_failure", "model_failure", "timeout", "refusal"];

function invalid(message: string): never {
  throw new ValidationError(`Invalid benchmark records: ${message}`);
}

function shape(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("object required");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || keys.some((key) => !(key in data))) invalid("unexpected fields");
  return data;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) invalid("invalid ID");
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid("SHA256 required");
  return value;
}

function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) invalid("nonempty bounded list required");
  return value;
}

function unique<T>(values: T[]): T[] {
  if (new Set(values).size !== values.length) invalid("duplicate plan entry");
  return values;
}

function number(value: unknown, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) invalid("nonnegative number required");
  return value;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value !== null && typeof value !== "boolean") invalid("boolean or null required");
  return value;
}

export function validateRunPlan(value: unknown): RunPlan {
  const data = shape(value, ["protocolSha256", "datasetSha256", "tasks", "methods", "seeds"]);
  const tasks = list(data.tasks, 10_000).map((task) => {
    const item = shape(task, ["id", "familyId"]);
    return { id: id(item.id), familyId: id(item.familyId) };
  });
  unique(tasks.map((task) => task.id));
  const methods = unique(list(data.methods, 20).map(id));
  const seeds = unique(list(data.seeds, 20).map((seed) => number(seed, true)));
  if (tasks.length * methods.length * seeds.length > 200_000) invalid("run grid too large");
  return { protocolSha256: hash(data.protocolSha256), datasetSha256: hash(data.datasetSha256), tasks, methods, seeds };
}

function validateRun(value: unknown, plan: RunPlan): RecordedRun {
  const data = shape(value, ["taskId", "method", "seed", "protocolSha256", "datasetSha256", "artifactSha256", "status", "oraclePassed", "staleAuthorityUsed", "unauthorizedAuthorityDelivered", "latencyMs", "inputTokens", "outputTokens", "costUsd"]);
  const taskId = id(data.taskId);
  const method = id(data.method);
  const seed = number(data.seed, true);
  if (!plan.tasks.some((task) => task.id === taskId) || !plan.methods.includes(method) || !plan.seeds.includes(seed)) invalid("run outside frozen plan");
  if (hash(data.protocolSha256) !== plan.protocolSha256 || hash(data.datasetSha256) !== plan.datasetSha256) invalid("run hash differs from frozen plan");
  if (typeof data.status !== "string" || !STATUSES.includes(data.status)) invalid("unknown run status");
  const status = data.status as RecordedRun["status"];
  const oraclePassed = nullableBoolean(data.oraclePassed);
  if ((status === "completed") !== (oraclePassed !== null)) invalid("completed run needs oracle result; failures cannot claim success");
  return {
    taskId, method, seed,
    protocolSha256: plan.protocolSha256, datasetSha256: plan.datasetSha256,
    artifactSha256: hash(data.artifactSha256), status, oraclePassed,
    staleAuthorityUsed: nullableBoolean(data.staleAuthorityUsed),
    unauthorizedAuthorityDelivered: nullableBoolean(data.unauthorizedAuthorityDelivered),
    latencyMs: number(data.latencyMs),
    inputTokens: data.inputTokens === null ? null : number(data.inputTokens, true),
    outputTokens: data.outputTokens === null ? null : number(data.outputTokens, true),
    costUsd: data.costUsd === null ? null : number(data.costUsd),
  };
}

function knownBoolean(values: Array<boolean | null>) {
  const observed = values.filter((value) => value !== null);
  return { positive: observed.filter(Boolean).length, observed: observed.length, unknown: values.length - observed.length };
}

function knownTotal(values: Array<number | null>, integer = false) {
  const observed = values.filter((value): value is number => value !== null);
  const sum = observed.reduce((total, value) => {
    const next = total + value;
    if (!Number.isFinite(next) || (integer && !Number.isSafeInteger(next))) invalid("aggregate metric exceeds numeric precision");
    return next;
  }, 0);
  return { total: observed.length === values.length && values.length > 0 ? sum : null, observed: observed.length, unknown: values.length - observed.length };
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Family-cluster bootstrap of paired task/seed success differences, not independent-seed CIs. */
function compare(plan: RunPlan, runs: RecordedRun[], baseline: string, treatment: string) {
  const index = new Map(runs.map((run) => [JSON.stringify([run.taskId, run.method, run.seed]), run]));
  const groups = new Map<string, number[]>();
  for (const task of plan.tasks) {
    const deltas = groups.get(task.familyId) ?? [];
    for (const seed of plan.seeds) {
      const a = index.get(JSON.stringify([task.id, baseline, seed]));
      const b = index.get(JSON.stringify([task.id, treatment, seed]));
      if (!a || !b) return { baseline, treatment, status: "incomplete" as const, difference: null, interval95: null };
      deltas.push(Number(b.oraclePassed === true) - Number(a.oraclePassed === true));
    }
    groups.set(task.familyId, deltas);
  }
  const families = [...groups.values()];
  const observed = families.flat();
  const difference = observed.reduce((sum, value) => sum + value, 0) / observed.length;
  const rng = random(20261030);
  const draws: number[] = [];
  for (let i = 0; i < 10_000; i++) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < families.length; j++) {
      const family = families[Math.floor(rng() * families.length)]!;
      sum += family.reduce((total, value) => total + value, 0);
      count += family.length;
    }
    draws.push(sum / count);
  }
  draws.sort((a, b) => a - b);
  return { baseline, treatment, status: "complete" as const, difference, interval95: [draws[249]!, draws[9749]!], families: families.length, descriptiveOnly: families.length < 10, resamples: 10_000, bootstrapSeed: 20261030 };
}

/** Missing runs stay missing; attempted infrastructure/model failures stay in the success denominator. */
export function scoreRecordedRuns(planValue: unknown, runValues: unknown) {
  const plan = validateRunPlan(planValue);
  if (!Array.isArray(runValues) || runValues.length > 200_000) invalid("run array required");
  const runs = runValues.map((value) => validateRun(value, plan));
  unique(runs.map((run) => JSON.stringify([run.taskId, run.method, run.seed])));
  const plannedPerMethod = plan.tasks.length * plan.seeds.length;
  return {
    format: "decision-lineage-recorded-scores-v1",
    protocolSha256: plan.protocolSha256, datasetSha256: plan.datasetSha256,
    complete: runs.length === plannedPerMethod * plan.methods.length,
    methods: plan.methods.map((method) => {
      const own = runs.filter((run) => run.method === method);
      const passed = own.filter((run) => run.oraclePassed === true).length;
      return {
        method, planned: plannedPerMethod, attempted: own.length, missing: plannedPerMethod - own.length,
        passed, successPerAttempt: own.length ? passed / own.length : null,
        statuses: Object.fromEntries(STATUSES.map((status) => [status, own.filter((run) => run.status === status).length])),
        staleAuthorityUsed: knownBoolean(own.map((run) => run.staleAuthorityUsed)),
        unauthorizedAuthorityDelivered: knownBoolean(own.map((run) => run.unauthorizedAuthorityDelivered)),
        inputTokens: knownTotal(own.map((run) => run.inputTokens), true),
        outputTokens: knownTotal(own.map((run) => run.outputTokens), true),
        costUsd: knownTotal(own.map((run) => run.costUsd)),
      };
    }),
    comparisons: plan.methods.slice(1).map((method) => compare(plan, runs, plan.methods[0]!, method)),
  };
}
