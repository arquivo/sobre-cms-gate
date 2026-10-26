// One JSON line per event on stdout. Callers pass only what may be kept: never a token, a code, a secret or file
// contents.
export type LogEvent = { event: string } & Record<string, string | number | boolean | null | undefined>;
export type Logger = (e: LogEvent) => void;

export const jsonLogger =
  (write: (line: string) => void = (line) => process.stdout.write(line)): Logger =>
  (e) =>
    write(`${JSON.stringify({ time: new Date().toISOString(), ...e })}\n`);
