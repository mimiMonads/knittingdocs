import { createPool, isMain, task } from "@vixeny/knitting";

export const hello = task({
  f: () => "hello ",
});

export const world = task({
  f: (args: string) => args + " world!",
});

const { call, shutdown } = createPool({})({
  hello,
  world,
});

if (isMain) {
  Promise.all(
    Array.from({
      length: 4,
    }).map(
      () => call.world(call.hello()),
    ),
  )
    .then(console.log)
    .finally(shutdown);
}
