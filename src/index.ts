import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// how each line is written
type Format = "text" | "json" | "logfmt";

// anything with a write method, like process.stderr
interface Writer {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

// reshapes a field before it is logged, at any depth
type Replacer = (key: string, value: unknown) => unknown;

interface Options {
  // the quietest level that gets through (default "info")
  level?: Level;
  // shown before every message, as "prefix:"
  prefix?: string;
  // added to every line
  fields?: object;
  // show the time on text lines (default true)
  time?: boolean;
  // an IANA time zone for the clock, like "America/New_York" (default: local)
  timeZone?: string;
  // "text" (default), "json" or "logfmt"
  format?: Format;
  // force colors on or off (default: on for a terminal, off with NO_COLOR)
  color?: boolean;
  // where lines go (default process.stderr)
  output?: Writer;
  // also append every line, without colors, to this file or to each day's file
  file?: string | ((day: string) => string);
  // reshapes fields before they are logged
  replacer?: Replacer;
  // the clock, handy for tests
  now?: () => Date;
}

type Log = (msg: string, fields?: object) => void;

interface Logger {
  debug: Log;
  info: Log;
  warn: Log;
  error: Log;
  // logs, then exits with code 1
  fatal: (msg: string, fields?: object) => never;
  // a new logger that adds these fields to every line
  with: (fields: object) => Logger;
  // a new logger with this prefix
  withPrefix: (prefix: string) => Logger;
  setLevel: (level: Level) => void;
  readonly level: Level;
}

// each level's rank, three-letter label and 256-color code
const levels = {
  debug: { rank: 0, label: "DBG", color: 63 },
  info: { rank: 1, label: "INF", color: 86 },
  warn: { rank: 2, label: "WRN", color: 192 },
  error: { rank: 3, label: "ERR", color: 204 },
  fatal: { rank: 4, label: "FTL", color: 134 },
} as const;

// "debug" | "info" | "warn" | "error" | "fatal", from the table above
type Level = keyof typeof levels;

const bold = "\x1b[1m";
const faint = "\x1b[2m";
const reset = "\x1b[0m";
const fg = (code: number) => `\x1b[38;5;${code}m`;

// text in the given styles, or as it is when colors are off
const paint = (on: boolean, text: string, ...styles: string[]) =>
  on ? `${styles.join("")}${text}${reset}` : text;

// colors for a terminal; NO_COLOR turns them off, FORCE_COLOR on
const supportsColor = (output: Writer): boolean => {
  const { NO_COLOR, FORCE_COLOR } = process.env;

  if (NO_COLOR) return false;
  if (FORCE_COLOR) return FORCE_COLOR !== "0" && FORCE_COLOR !== "false";

  return output.isTTY === true;
};

// values that do not log well as they are
const normalize = (value: unknown): unknown => {
  if (value instanceof Error) return value.message;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();

  return value;
};

// the replacer, then normalize: every field passes through this once
const shaper =
  (replacer?: Replacer) =>
  (key: string, value: unknown): unknown =>
    normalize(replacer ? replacer(key, value) : value);

// a value as text: quoted when it is empty or has spaces, = or quotes
const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return "<nil>";
  if (Array.isArray(value)) return `[${value.map(formatValue).join(" ")}]`;

  if (typeof value === "string") {
    return value === "" || /[\s="]/.test(value) ? JSON.stringify(value) : value;
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable]";
    }
  }

  return String(value);
};

// the fields as [key, value] pairs: nested objects flattened (a.b=1) and
// empty values left out
const pairs = (fields: object, replacer?: Replacer): [string, unknown][] => {
  const shape = shaper(replacer);
  const out: [string, unknown][] = [];
  const parents = new Set<object>();

  const walk = (node: object, path: string) => {
    parents.add(node);

    for (const [key, raw] of Object.entries(node)) {
      const value = shape(key, raw);
      const name = `${path}${key}`;

      if (value == null) continue;

      if (Array.isArray(value)) {
        out.push([name, value.filter((v) => v != null).map(normalize)]);
      } else if (typeof value !== "object") {
        out.push([name, value]);
      } else if (parents.has(value)) {
        out.push([name, "[circular]"]);
      } else {
        walk(value, `${name}.`);
      }
    }

    parents.delete(node);
  };

  walk(fields, "");

  return out;
};

// the date and the time of day, in a time zone
const makeClock = (timeZone?: string) => {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (date: Date) => {
    const p = Object.fromEntries(
      format.formatToParts(date).map(({ type, value }) => [type, value]),
    );

    return {
      day: `${p.year}-${p.month}-${p.day}`,
      time: `${p.hour}:${p.minute}:${p.second}`,
    };
  };
};

const createLogger = (options: Options = {}): Logger => {
  const {
    prefix,
    fields = {},
    time = true,
    timeZone,
    format = "text",
    output = process.stderr,
    file,
    replacer,
    now = () => new Date(),
  } = options;

  let threshold: Level = options.level ?? "info";

  const color = options.color ?? supportsColor(output);
  const clock = makeClock(timeZone);
  const shape = shaper(replacer);
  const madeDirs = new Set<string>();

  // the fields as plain, nested data for json
  const toData = (merged: object): object => {
    try {
      return JSON.parse(
        JSON.stringify(merged, (key, value) =>
          key === "" ? value : shape(key, value),
        ),
      );
    } catch {
      return Object.fromEntries(pairs(merged, replacer));
    }
  };

  // one line, without the newline
  const render = (
    level: Level,
    msg: string,
    extra: object | undefined,
    date: Date,
    colored: boolean,
  ): string => {
    const merged = { ...fields, ...extra };
    const meta = {
      time: date.toISOString(),
      level,
      ...(prefix ? { prefix } : {}),
      msg,
    };

    if (format === "json") {
      return JSON.stringify({ ...meta, ...toData(merged) });
    }

    const context = pairs(merged, replacer);

    if (format === "logfmt") {
      return [...Object.entries(meta), ...context]
        .map(([key, value]) => `${key}=${formatValue(value)}`)
        .join(" ");
    }

    const { label, color: code } = levels[level];

    return [
      time && clock(date).time,
      paint(colored, label, bold, fg(code)),
      prefix && paint(colored, `${prefix}:`, bold),
      msg,
      ...context.map(
        ([key, value]) => `${paint(colored, key, faint)}=${formatValue(value)}`,
      ),
    ]
      .filter(Boolean)
      .join(" ");
  };

  // a plain line onto the end of a file, making its folder the first time
  const append = (path: string, line: string) => {
    const dir = dirname(path);

    if (!madeDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    }

    appendFileSync(path, `${line}\n`);
  };

  const write = (level: Level, msg: string, extra?: object) => {
    if (levels[level].rank < levels[threshold].rank) return;

    const date = now();

    output.write(`${render(level, msg, extra, date, color)}\n`);

    if (file) {
      const path = typeof file === "function" ? file(clock(date).day) : file;

      append(path, render(level, msg, extra, date, false));
    }
  };

  const at =
    (level: Level): Log =>
    (msg, extra) =>
      write(level, msg, extra);

  // a new logger like this one, at its current level
  const child = (overrides: Options) =>
    createLogger({ ...options, level: threshold, ...overrides });

  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: (msg, extra) => {
      write("fatal", msg, extra);

      return process.exit(1);
    },
    with: (more) => child({ fields: { ...fields, ...more } }),
    withPrefix: (next) => child({ prefix: next }),
    setLevel: (level) => {
      threshold = level;
    },
    get level() {
      return threshold;
    },
  };
};

// a ready-made logger: info and up, to stderr
const log = createLogger();

export {
  createLogger,
  log,
  formatValue,
  pairs,
  type Format,
  type Level,
  type Logger,
  type Options,
  type Replacer,
  type Writer,
};
