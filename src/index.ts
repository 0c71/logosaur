import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The log levels, quietest first. */
type Level = "debug" | "info" | "warn" | "error" | "fatal";

/** How each line is written. */
type Format = "text" | "json" | "logfmt";

/** Anything with a `write` method, like `process.stderr`. */
interface Writer {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/** Turns a field into what gets logged, at any depth. */
type Replacer = (key: string, value: unknown) => unknown;

interface Options {
  /** The quietest level that gets through. Default `"info"`. */
  level?: Level;
  /** Shown before every message, as `prefix:`. */
  prefix?: string;
  /** Fields added to every line. */
  fields?: object;
  /** Show the time on text lines. Default `true`. */
  time?: boolean;
  /** An IANA time zone for the clock, like `"America/New_York"`. Default: local. */
  timeZone?: string;
  /** `"text"` (default), `"json"` or `"logfmt"`. */
  format?: Format;
  /** Force colors on or off. Default: on for a terminal, off with `NO_COLOR`. */
  color?: boolean;
  /** Where lines go. Default `process.stderr`. */
  output?: Writer;
  /** Also append every line, without colors, to this file (or to the file for each day). */
  file?: string | ((day: string) => string);
  /** Turns a field into what gets logged, at any depth. */
  replacer?: Replacer;
  /** The clock. Handy for tests. */
  now?: () => Date;
}

interface Logger {
  debug(msg: string, fields?: object): void;
  info(msg: string, fields?: object): void;
  warn(msg: string, fields?: object): void;
  error(msg: string, fields?: object): void;
  /** Logs, then exits with code 1. */
  fatal(msg: string, fields?: object): never;
  /** A new logger that adds these fields to every line. */
  with(fields: object): Logger;
  /** A new logger with this prefix. */
  withPrefix(prefix: string): Logger;
  /** Change the quietest level that gets through. */
  setLevel(level: Level): void;
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

const reset = "\x1b[0m";
const bold = "\x1b[1m";
const faint = "\x1b[2m";
const paint = (code: number) => `\x1b[38;5;${code}m`;

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

// the fields as [key, value] pairs: nested objects flattened (a.b=1), empty
// values left out, the replacer applied at every depth
const pairs = (fields: object, replacer?: Replacer): [string, unknown][] => {
  const out: [string, unknown][] = [];
  const parents = new Set<object>();

  const walk = (node: object, path: string) => {
    parents.add(node);

    for (const [key, raw] of Object.entries(node)) {
      const value = normalize(replacer ? replacer(key, raw) : raw);
      const name = `${path}${key}`;

      if (value === null || value === undefined) continue;

      if (Array.isArray(value)) {
        out.push([name, value.filter((v) => v != null).map(normalize)]);
      } else if (typeof value === "object") {
        if (parents.has(value)) {
          out.push([name, "[circular]"]);
        } else {
          walk(value, `${name}.`);
        }
      } else {
        out.push([name, value]);
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
    const p: Record<string, string> = {};

    for (const { type, value } of format.formatToParts(date)) {
      p[type] = value;
    }

    return {
      day: `${p.year}-${p.month}-${p.day}`,
      time: `${p.hour}:${p.minute}:${p.second}`,
    };
  };
};

/** Make a logger. */
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
  const madeDirs = new Set<string>();

  // one line, without the newline
  const render = (
    level: Level,
    msg: string,
    extra: object | undefined,
    date: Date,
    colored: boolean,
  ): string => {
    const merged = { ...fields, ...extra };

    if (format === "json") {
      let data: object;

      try {
        data = JSON.parse(
          JSON.stringify(merged, (key, value) =>
            key === "" ? value : normalize(replacer ? replacer(key, value) : value),
          ),
        );
      } catch {
        data = Object.fromEntries(pairs(merged, replacer));
      }

      return JSON.stringify({
        time: date.toISOString(),
        level,
        ...(prefix ? { prefix } : {}),
        msg,
        ...data,
      });
    }

    const context = pairs(merged, replacer);

    if (format === "logfmt") {
      const head: [string, unknown][] = [
        ["time", date.toISOString()],
        ["level", level],
      ];

      if (prefix) head.push(["prefix", prefix]);
      head.push(["msg", msg]);

      return [...head, ...context]
        .map(([key, value]) => `${key}=${formatValue(value)}`)
        .join(" ");
    }

    const { label, color: code } = levels[level];
    const parts: string[] = [];

    if (time) parts.push(clock(date).time);
    parts.push(colored ? `${bold}${paint(code)}${label}${reset}` : label);
    if (prefix) parts.push(colored ? `${bold}${prefix}:${reset}` : `${prefix}:`);
    if (msg) parts.push(msg);

    for (const [key, value] of context) {
      const shown = formatValue(value);

      parts.push(colored ? `${faint}${key}${reset}=${shown}` : `${key}=${shown}`);
    }

    return parts.join(" ");
  };

  const write = (level: Level, msg: string, extra?: object) => {
    if (levels[level].rank < levels[threshold].rank) return;

    const date = now();

    output.write(`${render(level, msg, extra, date, color)}\n`);

    if (!file) return;

    const path = typeof file === "function" ? file(clock(date).day) : file;
    const dir = dirname(path);

    if (!madeDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    }

    appendFileSync(path, `${render(level, msg, extra, date, false)}\n`);
  };

  return {
    debug: (msg, extra) => write("debug", msg, extra),
    info: (msg, extra) => write("info", msg, extra),
    warn: (msg, extra) => write("warn", msg, extra),
    error: (msg, extra) => write("error", msg, extra),
    fatal: (msg, extra): never => {
      write("fatal", msg, extra);

      return process.exit(1);
    },
    with: (more) =>
      createLogger({ ...options, level: threshold, fields: { ...fields, ...more } }),
    withPrefix: (next) => createLogger({ ...options, level: threshold, prefix: next }),
    setLevel: (level) => {
      threshold = level;
    },
    get level() {
      return threshold;
    },
  };
};

/** A ready-made logger: info and up, to stderr. */
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
