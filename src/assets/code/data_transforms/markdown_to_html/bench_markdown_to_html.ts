import { createPool, isMain, task } from "@vixeny/knitting";
import { bench, boxplot, run, summary } from "mitata";
import { brotliCompressSync } from "node:zlib";
import { markdownToHtmlHost } from "./render_markdown.ts";

function intArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < process.argv.length) {
    const value = Number(process.argv[i + 1]);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return fallback;
}

const THREADS = intArg("threads", 2);
const DOCS = intArg("docs", 2_000);

const TOPICS = [
  "workers",
  "schema",
  "compression",
  "batching",
  "latency",
  "rendering",
  "validation",
  "throughput",
];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length]!;
}

function makeMarkdown(i: number): string {
  const topicA = pick(TOPICS, i);
  const topicB = pick(TOPICS, i + 3);
  const topicC = pick(TOPICS, i + 5);
  const id = i.toString(36);

  return [
    `# Job ${id.toUpperCase()}`,
    "",
    `This page documents a ${topicA} pipeline for ${topicB}.`,
    "",
    "## Checklist",
    "",
    `- Parse input payload ${id}`,
    "- Validate required fields and defaults",
    `- Render output for ${topicC}`,
    "",
    "## Sample code",
    "",
    "```ts",
    `const jobId = "${id}";`,
    'const status = "ready";',
    "```",
    "",
    `Generated at 2026-01-${String((i % 27) + 1).padStart(2, "0")}.`,
  ].join("\n");
}

function renderHeavy(markdown: string): Uint8Array {
  const html = markdownToHtmlHost(markdown);
  return brotliCompressSync(html);
}

export const markdownToHtmlHeavy = task<string, Uint8Array>({
  f: (markdown) => renderHeavy(markdown),
});

function runHost(markdowns: string[]): Uint8Array[] {
  const outputs = new Array<Uint8Array>(markdowns.length);
  for (let i = 0; i < markdowns.length; i++) {
    outputs[i] = renderHeavy(markdowns[i]!);
  }
  return outputs;
}

async function runWorkers(
  callMarkdown: (markdown: string) => Promise<Uint8Array>,
  markdowns: string[],
): Promise<Uint8Array[]> {
  const jobs: Promise<Uint8Array>[] = [];
  for (let i = 0; i < markdowns.length; i++) {
    jobs.push(callMarkdown(markdowns[i]!));
  }
  return Promise.all(jobs);
}

function sumBytes(chunks: Uint8Array[]): number {
  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    total += chunks[i]!.length;
  }
  return total;
}

function sameChunks(a: Uint8Array[], b: Uint8Array[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.length !== right.length) return false;
    for (let j = 0; j < left.length; j++) {
      if (left[j] !== right[j]) return false;
    }
  }

  return true;
}

async function main() {
  const markdowns = new Array<string>(DOCS);
  for (let i = 0; i < DOCS; i++) {
    markdowns[i] = makeMarkdown(i);
  }

  const pool = createPool({ threads: THREADS - 1 ,
    inliner: {
      batchSize: 8
    }
   })({ markdownToHtmlHeavy });
  let sink = 0;

  try {
    const expected = runHost(markdowns);
    const workerCheck = await runWorkers(pool.call.markdownToHtmlHeavy, markdowns);
    if (!sameChunks(expected, workerCheck)) {
      throw new Error("Host and worker raw bytes differ. Aborting benchmark.");
    }

    console.log("Markdown -> HTML heavy benchmark (mitata)");
    console.log("workload: parse + brotli, return raw compressed bytes");
    console.log("docs per iteration:", DOCS.toLocaleString());
    console.log("threads:", THREADS);

    boxplot(() => {
      summary(() => {
        bench(`host (${DOCS.toLocaleString()} docs)`, () => {
          sink = sumBytes(runHost(markdowns));
        });

        bench(`knitting (${THREADS} thread${THREADS === 1 ? "" : "s"}, ${DOCS.toLocaleString()} docs)`, async () => {
          sink = sumBytes(await runWorkers(pool.call.markdownToHtmlHeavy, markdowns));
        });
      });
    });

    await run();
    console.log("last compressed bytes:", sink.toLocaleString());
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
