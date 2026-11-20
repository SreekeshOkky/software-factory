// Console log, also appended to $DATA_DIR/factory.log so it survives container
// recreation (docker's own log goes away with the container).
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

const file = process.env.VITEST ? undefined : join(process.env.DATA_DIR ?? "/data", "factory.log");
let fileOk = Boolean(file);

function write(level: string, out: (s: string) => void, a: unknown[]) {
  const line = `${new Date().toISOString()} ${level} ${format(...a)}`;
  out(line);
  if (!fileOk) return;
  try {
    appendFileSync(file!, line + "\n");
  } catch {
    try {
      mkdirSync(join(file!, ".."), { recursive: true });
      appendFileSync(file!, line + "\n");
    } catch {
      fileOk = false; // e.g. running outside the container; console still works
    }
  }
}

export const log = {
  info: (...a: unknown[]) => write("INFO ", console.log, a),
  warn: (...a: unknown[]) => write("WARN ", console.warn, a),
  error: (...a: unknown[]) => write("ERROR", console.error, a),
};
