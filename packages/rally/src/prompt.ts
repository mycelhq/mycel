// The terminal prompt, alone in a file because it is the only thing the deleted login flow left
// behind that anything still uses.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export function prompter(): { ask: (q: string) => Promise<string>; close: () => void } {
  const rl = createInterface({ input: stdin, output: stdout });
  return { ask: (q: string) => rl.question(q), close: () => rl.close() };
}
