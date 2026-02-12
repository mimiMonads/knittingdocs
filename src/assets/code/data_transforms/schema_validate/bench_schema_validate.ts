import { createPool, isMain } from "@vixeny/knitting";
import { bench, boxplot, run, summary } from "mitata";
import {
  parseAndValidateBatchFast,
  parseAndValidateBatchFastHost,
  type ValidationSummary,
} from "./parse_validate.ts";

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
const INVALID_PERCENT = Math.max(0, Math.min(95, intArg("invalid", 15)));
const BATCH = Math.max(1, intArg("batch", 64));

function makeValidPayload(i: number): string {
  const short = i.toString(36);
  const role = i % 9 === 0 ? "admin" : "user";

  return JSON.stringify({
    id: `u_${short}`,
    email: `${short}@knitting.dev`,
    displayName: `User ${short.toUpperCase()}`,
    age: 18 + (i % 60),
    roles: [role],
    marketingOptIn: i % 2 === 0,
  });
}

function makePayload(i: number): string {
  if (i % 100 >= INVALID_PERCENT) return makeValidPayload(i);

  switch (i % 4) {
    case 0:
      return '{"id":"broken"';
    case 1:
      return JSON.stringify({
        id: `u_${i}`,
        displayName: `User ${i}`,
        age: 33,
        roles: ["user"],
        marketingOptIn: true,
      });
    case 2:
      return JSON.stringify({
        id: `u_${i}`,
        email: `u_${i}@knitting.dev`,
        displayName: "x",
        age: "unknown",
        roles: ["user"],
      });
    default:
      return JSON.stringify({
        id: `u_${i}`,
        email: `u_${i}@knitting.dev`,
        displayName: `User ${i}`,
        age: 31,
        roles: ["owner"],
      });
  }
}

function makeBatches(payloads: string[], batchSize: number): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < payloads.length; i += batchSize) {
    batches.push(payloads.slice(i, i + batchSize));
  }
  return batches;
}

function mergeSummary(a: ValidationSummary, b: ValidationSummary): ValidationSummary {
  return {
    valid: a.valid + b.valid,
    invalid: a.invalid + b.invalid,
  };
}

function runHostBatches(payloadBatches: string[][]): ValidationSummary {
  let totals: ValidationSummary = { valid: 0, invalid: 0 };

  for (let i = 0; i < payloadBatches.length; i++) {
    totals = mergeSummary(
      totals,
      parseAndValidateBatchFastHost(payloadBatches[i]!),
    );
  }

  return totals;
}

async function runWorkerBatches(
  callBatch: (payloads: string[]) => Promise<ValidationSummary>,
  payloadBatches: string[][],
): Promise<ValidationSummary> {
  const jobs: Promise<ValidationSummary>[] = [];
  for (let i = 0; i < payloadBatches.length; i++) {
    jobs.push(callBatch(payloadBatches[i]!));
  }

  const results = await Promise.all(jobs);

  let totals: ValidationSummary = { valid: 0, invalid: 0 };
  for (let i = 0; i < results.length; i++) {
    totals = mergeSummary(totals, results[i]!);
  }
  return totals;
}

function sameSummary(a: ValidationSummary, b: ValidationSummary): boolean {
  return a.valid === b.valid && a.invalid === b.invalid;
}

async function main() {
  const payloads = new Array<string>(REQUESTS);
  for (let i = 0; i < REQUESTS; i++) {
    payloads[i] = makePayload(i);
  }
  const payloadBatches = makeBatches(payloads, BATCH);

  const pool = createPool({ threads: THREADS -1 , 
    inliner: {
      position: "last",
      batchSize: 8
    }

  })({ parseAndValidateBatchFast });
  let sink = 0;

  try {
    const hostCheck = runHostBatches(payloadBatches);
    const workerCheck = await runWorkerBatches(
      pool.call.parseAndValidateBatchFast,
      payloadBatches,
    );
    if (!sameSummary(hostCheck, workerCheck)) {
      throw new Error("Host and worker validation counts differ.");
    }

    console.log("Zod parse+validate benchmark (mitata)");
    console.log("workload: JSON.parse + UserSchema.safeParse");
    console.log("requests per iteration:", REQUESTS.toLocaleString());
    console.log("invalid rate:", `${INVALID_PERCENT}%`);
    console.log("batch size:", BATCH);
    console.log("threads:", THREADS);

    boxplot(() => {
      summary(() => {
        bench(`host (${REQUESTS.toLocaleString()} req, batch ${BATCH})`, () => {
          const totals = runHostBatches(payloadBatches);
          sink = totals.valid;
        });

        bench(`knitting (${THREADS} thread${THREADS === 1 ? "" : "s"}, ${REQUESTS.toLocaleString()} req, batch ${BATCH})`, async () => {
          const totals = await runWorkerBatches(
            pool.call.parseAndValidateBatchFast,
            payloadBatches,
          );
          sink = totals.valid;
        });
      });
    });

    await run();
    console.log("last valid count:", sink.toLocaleString());
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
