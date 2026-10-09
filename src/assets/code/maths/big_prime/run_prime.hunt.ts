import { createPool, isMain } from "knitting";
import {
  scanForProbablePrime,
  type ScanResult,
} from "./prime_scan.ts";

type Options = {
  threads: number;
  bits: number;
  region: number;
  rounds: number;
};

type AbortablePromise<T> = Promise<T> & {
  reject: (reason?: unknown) => void;
};

function positiveIntArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : Number(process.argv[index + 1]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function readOptions(): Options {
  return {
    threads: positiveIntArg("threads", 4),
    bits: positiveIntArg("bits", 1_500),
    region: positiveIntArg("region", 1_000_000_000),
    rounds: positiveIntArg("rounds", 8),
  };
}

function xorshift32(state: number): number {
  state |= 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state | 0;
}

function makeRandomOdd(bits: number, seed: number): bigint {
  let state = seed;
  let value = 0n;

  for (let offset = 0; offset < bits; offset += 32) {
    state = xorshift32(state);
    value = (value << 32n) | BigInt(state >>> 0);
  }

  const mask = (1n << BigInt(bits)) - 1n;
  return (value & mask) | (1n << BigInt(bits - 1)) | 1n;
}

function waitForFirstPrime(
  jobs: AbortablePromise<ScanResult>[],
): Promise<ScanResult | null> {
  return new Promise((resolve, reject) => {
    let remaining = jobs.length;

    for (const job of jobs) {
      job.then(
        (result) => {
          if (result.prime !== null) {
            resolve(result);
            return;
          }

          remaining--;
          if (remaining === 0) resolve(null);
        },
        reject,
      );
    }
  });
}

async function main() {
  const options = readOptions();
  const start = makeRandomOdd(options.bits, 0x6d2b_79f5);
  const workerCount = Math.min(options.threads, options.region);
  const step = 2 * options.threads;

  using pool = createPool({
    threads: options.threads,
    abortSignalCapacity: workerCount,
  })({ scanForProbablePrime });

  const started = performance.now();
  const jobs: AbortablePromise<ScanResult>[] = [];

  for (let worker = 0; worker < workerCount; worker++) {
    const count = Math.ceil((options.region - worker) / options.threads);
    const workerStart = start + 2n * BigInt(worker);

    jobs.push(
      pool.call.scanForProbablePrime([
        workerStart.toString(),
        count,
        step,
        options.rounds,
      ]),
    );
  }

  let winner: ScanResult | null;
  try {
    winner = await waitForFirstPrime(jobs);
    if (winner !== null) {
      for (const job of jobs) job.reject();
    }

    const results = await Promise.all(jobs);
    const tested = results.reduce((total, result) => total + result.tested, 0);
    const cancelled = results.some((result) => result.aborted);
    const elapsed = performance.now() - started;

    console.log(`threads:    ${options.threads}`);
    console.log(`bits:       ${options.bits}`);
    console.log(`region:     ${options.region.toLocaleString()} odd candidates`);
    console.log(`workers:    ${workerCount}`);
    console.log(`tested:     ${tested.toLocaleString()}`);
    console.log(`prime:      ${winner?.prime ?? "not found"}`);
    console.log(`cancelled:  ${cancelled ? "yes" : "no"}`);
    console.log(`elapsed:    ${elapsed.toFixed(0)} ms`);
  } catch (error) {
    for (const job of jobs) job.reject();
    await Promise.allSettled(jobs);
    throw error;
  }
}

if (isMain) {
  await main();
}
