import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger, formatValue, pairs, type Options } from "./index.ts";

// 19:02:03 UTC = 14:02:03 in New York (EST)
const at = new Date("2026-11-17T19:02:03Z");

// a logger writing into an array, plain, on a fixed UTC clock
const make = (options: Options = {}) => {
  const lines: string[] = [];
  const output = { write: (chunk: string) => lines.push(chunk.replace(/\n$/, "")) };
  const logger = createLogger({
    color: false,
    timeZone: "UTC",
    now: () => at,
    output,
    ...options,
  });

  return { lines, logger };
};

describe("formatValue", () => {
  test("quotes strings only when needed", () => {
    expect(formatValue("rex")).toBe("rex");
    expect(formatValue("")).toBe('""');
    expect(formatValue("very close")).toBe('"very close"');
    expect(formatValue("a=b")).toBe('"a=b"');
  });

  test("shows nil, arrays and objects", () => {
    expect(formatValue(null)).toBe("<nil>");
    expect(formatValue([1, "two words"])).toBe('[1 "two words"]');
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("pairs", () => {
  test("flattens nested objects and drops empty values", () => {
    expect(pairs({ a: { b: 1, c: null }, d: undefined, e: [1, null, 2] })).toEqual([
      ["a.b", 1],
      ["e", [1, 2]],
    ]);
  });

  test("logs errors as their message and dates as ISO", () => {
    expect(pairs({ err: new Error("boom"), at })).toEqual([
      ["err", "boom"],
      ["at", "2026-11-17T19:02:03.000Z"],
    ]);
  });

  test("survives circular objects", () => {
    const egg: Record<string, unknown> = { size: "large" };
    egg.self = egg;

    expect(pairs({ egg })).toEqual([
      ["egg.size", "large"],
      ["egg.self", "[circular]"],
    ]);
  });

  test("applies the replacer at every depth", () => {
    const replacer = (key: string, value: unknown) =>
      key === "dino" ? (value as { name: string }).name : value;

    expect(pairs({ pen: { dino: { name: "rex", teeth: 60 } } }, replacer)).toEqual([
      ["pen.dino", "rex"],
    ]);
  });
});

describe("text", () => {
  test("time, label, message and fields", () => {
    const { lines, logger } = make();

    logger.info("hatched", { name: "rex", mood: "very hungry" });

    expect(lines).toEqual(['19:02:03 INF hatched name=rex mood="very hungry"']);
  });

  test("three-letter labels, quietest level filtered out", () => {
    const { lines, logger } = make({ time: false });

    logger.debug("hidden");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.setLevel("debug");
    logger.debug("d");

    expect(lines).toEqual(["INF i", "WRN w", "ERR e", "DBG d"]);
    expect(logger.level).toBe("debug");
  });

  test("prefix", () => {
    const { lines, logger } = make({ time: false, prefix: "nest" });

    logger.withPrefix("cave").info("hi");
    logger.info("hi");

    expect(lines).toEqual(["INF cave: hi", "INF nest: hi"]);
  });

  test("with adds fields to a new logger only", () => {
    const { lines, logger } = make({ time: false, fields: { app: "park" } });

    logger.with({ pen: 7 }).warn("loose", { species: "raptor" });
    logger.info("calm");

    expect(lines).toEqual(["WRN loose app=park pen=7 species=raptor", "INF calm app=park"]);
  });

  test("time zone", () => {
    const { lines, logger } = make({ timeZone: "America/New_York" });

    logger.info("dinner");

    expect(lines).toEqual(["14:02:03 INF dinner"]);
  });

  test("colors when asked", () => {
    const { lines, logger } = make({ color: true, time: false });

    logger.error("meteor", { size: "big" });

    expect(lines[0]).toContain("\x1b[38;5;204m");
    expect(lines[0]).toContain("ERR");
    expect(lines[0]).toContain("\x1b[2msize\x1b[0m=big");
  });
});

describe("colors from the environment", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env.NO_COLOR = saved.NO_COLOR;
    process.env.FORCE_COLOR = saved.FORCE_COLOR;
    if (saved.NO_COLOR === undefined) delete process.env.NO_COLOR;
    if (saved.FORCE_COLOR === undefined) delete process.env.FORCE_COLOR;
  });

  const tty = (lines: string[]) => ({
    isTTY: true,
    write: (chunk: string) => lines.push(chunk),
  });

  test("NO_COLOR turns them off on a terminal", () => {
    process.env.NO_COLOR = "1";
    const lines: string[] = [];

    createLogger({ output: tty(lines), time: false }).info("hi");

    expect(lines[0]).toBe("INF hi\n");
  });

  test("FORCE_COLOR turns them on off a terminal", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    const lines: string[] = [];

    createLogger({ output: { write: (c: string) => lines.push(c) }, time: false }).info("hi");

    expect(lines[0]).toContain("\x1b[");
  });
});

describe("formats", () => {
  test("json keeps nested fields", () => {
    const { lines, logger } = make({ format: "json", prefix: "nest" });

    logger.info("hatched", { egg: { size: "large" }, err: new Error("cracked") });

    expect(JSON.parse(lines[0] ?? "")).toEqual({
      time: "2026-11-17T19:02:03.000Z",
      level: "info",
      prefix: "nest",
      msg: "hatched",
      egg: { size: "large" },
      err: "cracked",
    });
  });

  test("logfmt", () => {
    const { lines, logger } = make({ format: "logfmt" });

    logger.warn("meteor spotted", { distance: "very close" });

    expect(lines).toEqual([
      'time=2026-11-17T19:02:03.000Z level=warn msg="meteor spotted" distance="very close"',
    ]);
  });
});

describe("file", () => {
  test("appends plain lines to the day's file", () => {
    const dir = mkdtempSync(join(tmpdir(), "logosaur-"));

    try {
      const { logger } = make({
        color: true,
        file: (day) => join(dir, "logs", `${day}.log`),
      });

      logger.info("one", { n: 1 });
      logger.error("two");

      expect(readFileSync(join(dir, "logs", "2026-11-17.log"), "utf8")).toBe(
        "19:02:03 INF one n=1\n19:02:03 ERR two\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fatal", () => {
  test("logs, then exits with code 1", () => {
    const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);

    try {
      const { lines, logger } = make({ time: false });

      logger.fatal("extinct", { cause: "meteor" });

      expect(lines).toEqual(["FTL extinct cause=meteor"]);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });
});
