// the built package, run in node: what users get from npm
import assert from "node:assert/strict";

import { createLogger } from "../dist/index.js";

const lines = [];
const log = createLogger({
  color: false,
  timeZone: "UTC",
  now: () => new Date("2026-11-17T19:02:03Z"),
  output: { write: (line) => lines.push(line) },
});

log.info("hatched", { name: "rex", egg: { size: "large" } });
log.with({ pen: 7 }).withPrefix("cave").warn("echo");
log.debug("hidden");

assert.deepEqual(lines, [
  "19:02:03 INF hatched name=rex egg.size=large\n",
  "19:02:03 WRN cave: echo pen=7\n",
]);

console.log(`🦖 logosaur works in node ${process.version}`);
