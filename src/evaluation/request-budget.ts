import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { GuardProviderError } from "../decision-guard/errors.ts";

// Rates verified for this demo on 2026-10-31. Integer nanodollars avoid rounding
// a request over the local $0.10 ceiling down into the permitted allowance.
const INPUT_NANO_USD_PER_TOKEN = 1_250;
const OUTPUT_NANO_USD_PER_TOKEN = 4_250;
const MAX_NANO_USD = 100_000_000;
const MAX_LEDGER_BYTES = 16_384;

function estimateNanoUsd(outgoingJsonBytes: number, maxOutputTokens: number): number {
  return outgoingJsonBytes * INPUT_NANO_USD_PER_TOKEN + maxOutputTokens * OUTPUT_NANO_USD_PER_TOKEN;
}

/** Local conservative estimate, never provider tokenization or an actual bill. */
export function estimateDemoRequest(body: unknown) {
  if (typeof body !== "string") throw new GuardProviderError("budget", "The dedicated demo requires an inspectable JSON request body");
  let request: unknown;
  try { request = JSON.parse(body); }
  catch { throw new GuardProviderError("budget", "The dedicated demo requires a valid JSON request body"); }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new GuardProviderError("budget", "The dedicated demo requires a JSON request object");
  }
  const { model, max_completion_tokens: maxOutputTokens } = request as Record<string, unknown>;
  if (model !== "muse-spark-1.3" || typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096) {
    throw new GuardProviderError("budget", "The dedicated demo requires the verified model and an output cap of at most 4096 tokens");
  }
  // Count the entire outgoing JSON, including schema and envelope, rather than
  // guessing from characters in the selected excerpts alone.
  const outgoingJsonBytes = Buffer.byteLength(body, "utf8");
  const upperBoundNanoUsd = estimateNanoUsd(outgoingJsonBytes, maxOutputTokens);
  if (!Number.isSafeInteger(upperBoundNanoUsd) || upperBoundNanoUsd > MAX_NANO_USD) {
    throw new GuardProviderError("budget", "The conservative dedicated demo request estimate exceeds the $0.10 allowance; nothing was dispatched");
  }
  return {
    model, maxOutputTokens, outgoingJsonBytes, inputTokenUpperBound: outgoingJsonBytes,
    conservativeEstimatedMaxCostUsd: upperBoundNanoUsd / 1_000_000_000,
    requestCostCeilingUsd: 0.10,
    ratesUsdPerMillionTokens: { input: 1.25, output: 4.25 },
    ratesVerifiedOn: "2026-10-31",
    costClassification: "conservative estimate from complete JSON byte count and output cap; not actual usage or billing",
  };
}

/** Retained attempts count even when their network call failed or output was rejected. */
async function priorEstimateNanoUsd(path: string): Promise<number | null> {
  let file;
  try { file = await open(path, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new GuardProviderError("budget", "A retained demo dispatch ledger could not be checked; nothing was dispatched");
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_LEDGER_BYTES) throw new Error("Invalid ledger file");
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ledger object");
    const record = value as Record<string, unknown>;
    const bytes = record.outgoingJsonBytes;
    const cap = record.maxOutputTokens;
    if (record.model !== "muse-spark-1.3" || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 ||
        typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1 || cap > 4096 ||
        record.inputTokenUpperBound !== bytes || record.requestCostCeilingUsd !== 0.10) throw new Error("Invalid ledger estimate");
    const estimate = estimateNanoUsd(bytes, cap);
    const rates = record.ratesUsdPerMillionTokens as Record<string, unknown> | null;
    if (!Number.isSafeInteger(estimate) || estimate > MAX_NANO_USD ||
        record.conservativeEstimatedMaxCostUsd !== estimate / 1_000_000_000 ||
        !rates || typeof rates !== "object" || rates.input !== 1.25 || rates.output !== 4.25) throw new Error("Invalid ledger accounting");
    return estimate;
  } catch {
    throw new GuardProviderError("budget", "A retained demo dispatch ledger is malformed or inconsistent; nothing was dispatched");
  } finally { await file.close(); }
}

/**
 * Exclusive, flushed ledger precedes each dispatch, including failed calls.
 * The app owns one database and selects slots sequentially. Separate slots are
 * not a distributed reservation system; never run competing demo app owners.
 */
export function createBudgetedDemoFetcher(ledgerPath: string, networkFetch: typeof fetch = fetch,
  priorLedgerPaths: readonly string[] = []): typeof fetch {
  return async (input, init) => {
    const estimate = estimateDemoRequest(init?.body);
    const currentPath = resolve(ledgerPath);
    const priorPaths = [...new Set(priorLedgerPaths.map((path) => resolve(path)))].filter((path) => path !== currentPath);
    const priorEstimates = await Promise.all(priorPaths.map(priorEstimateNanoUsd));
    const priorNanoUsd = priorEstimates.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const aggregateNanoUsd = priorNanoUsd + estimateNanoUsd(estimate.outgoingJsonBytes, estimate.maxOutputTokens);
    if (!Number.isSafeInteger(aggregateNanoUsd) || aggregateNanoUsd > MAX_NANO_USD) {
      throw new GuardProviderError("budget", "The aggregate conservative demo estimate exceeds the $0.10 allowance; nothing was dispatched");
    }
    let ledger;
    try { ledger = await open(ledgerPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new GuardProviderError("budget", "The dedicated demo dispatch allowance is exhausted");
      throw error;
    }
    try {
      await ledger.writeFile(JSON.stringify({ dispatchedAt: new Date().toISOString(), ...estimate,
        priorDispatchAttempts: priorEstimates.filter((value) => value !== null).length,
        priorConservativeEstimatedMaxCostUsd: priorNanoUsd / 1_000_000_000,
        aggregateConservativeEstimatedMaxCostUsd: aggregateNanoUsd / 1_000_000_000,
        aggregateCostCeilingUsd: 0.10 }) + "\n");
      await ledger.sync();
    } finally { await ledger.close(); }
    return networkFetch(input, init);
  };
}
