import { createPool, isMain } from "@vixeny/knitting";
import { bench, boxplot, run, summary } from "mitata";
import {
  buildDemoRevalidateRequests,
  revalidateTokenBatchFast,
  revalidateTokenBatchFastHost,
  type RenewalSummary,
} from "./jwt_revalidation.ts";

function intArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < process.argv.length) {
    const value = Number(process.argv[i + 1]);
    if (Number.isFinite(value)) return Math.floor(value);
  }
  return fallback;
}

const THREADS = Math.max(1, intArg("threads", 2));
const REQUESTS = Math.max(1, intArg("requests", 50_000));
const INVALID_PERCENT = Math.max(0, Math.min(95, intArg("invalid", 10)));
const BATCH = Math.max(1, intArg("batch", 64));

function makeBatches(rawRequests: string[], batchSize: number): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < rawRequests.length; i += batchSize) {
    batches.push(rawRequests.slice(i, i + batchSize));
  }
  return batches;
}

function mergeSummary(a: RenewalSummary, b: RenewalSummary): RenewalSummary {
  return {
    ok: a.ok + b.ok,
    renewed: a.renewed + b.renewed,
    rejected: a.rejected + b.rejected,
    outputBytes: a.outputBytes + b.outputBytes,
  };
}

async function runHostBatches(rawBatches: string[][]): Promise<RenewalSummary> {
  let totals: RenewalSummary = { ok: 0, renewed: 0, rejected: 0, outputBytes: 0 };

  for (let i = 0; i < rawBatches.length; i++) {
    totals = mergeSummary(totals, await revalidateTokenBatchFastHost(rawBatches[i]!));
  }

  return totals;
}

async function runWorkerBatches(
  callBatch: (rawRequests: string[]) => Promise<RenewalSummary>,
  rawBatches: string[][],
): Promise<RenewalSummary> {
  const jobs: Promise<RenewalSummary>[] = [];
  for (let i = 0; i < rawBatches.length; i++) {
    jobs.push(callBatch(rawBatches[i]!));
  }

  const results = await Promise.all(jobs);

  let totals: RenewalSummary = { ok: 0, renewed: 0, rejected: 0, outputBytes: 0 };
  for (let i = 0; i < results.length; i++) {
    totals = mergeSummary(totals, results[i]!);
  }
  return totals;
}

function sameSummary(a: RenewalSummary, b: RenewalSummary): boolean {
  return a.ok === b.ok &&
    a.renewed === b.renewed &&
    a.rejected === b.rejected &&
    a.outputBytes === b.outputBytes;
}

async function main() {
  const rawRequests = await buildDemoRevalidateRequests({
    count: REQUESTS,
    invalidPercent: INVALID_PERCENT,
  });
  const rawBatches = makeBatches(rawRequests, BATCH);

  const pool = createPool({ threads: THREADS })({ revalidateTokenBatchFast });
  let sink = 0;

  try {
    const hostCheck = await runHostBatches(rawBatches);
    const workerCheck = await runWorkerBatches(
      pool.call.revalidateTokenBatchFast,
      rawBatches,
    );
    if (!sameSummary(hostCheck, workerCheck)) {
      throw new Error("Host and worker JWT summaries differ.");
    }

    console.log("JWT revalidation benchmark (mitata)");
    console.log("workload: verify token -> renew when allowed -> JSON.stringify");
    console.log("requests per iteration:", REQUESTS.toLocaleString());
    console.log("invalid rate:", `${INVALID_PERCENT}%`);
    console.log("batch size:", BATCH);
    console.log("threads:", THREADS);

    boxplot(() => {
      summary(() => {
        bench(`host (${REQUESTS.toLocaleString()} req, batch ${BATCH})`, async () => {
          const totals = await runHostBatches(rawBatches);
          sink = totals.outputBytes;
        });

        bench(`knitting (${THREADS} thread${THREADS === 1 ? "" : "s"}, ${REQUESTS.toLocaleString()} req, batch ${BATCH})`, async () => {
          const totals = await runWorkerBatches(
            pool.call.revalidateTokenBatchFast,
            rawBatches,
          );
          sink = totals.outputBytes;
        });
      });
    });

    await run();
    console.log("last output bytes:", sink.toLocaleString());
  } finally {
    pool.shutdown();
  }
}

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
