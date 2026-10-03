import { createInterface } from 'node:readline/promises';
import { createInterface as createLineReader } from 'node:readline';
import type { ReadStream } from 'node:tty';

export async function question(prompt: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr, historySize: 0 });
  try { return await reader.question(prompt); }
  finally { reader.close(); }
}

/** Ask for the two split session-cookie values, with visible input. */
export async function readCookieInput(input: ReadStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Promise<string> {
  if (!input.isTTY) throw new Error('Cookie pasting requires an interactive terminal. Run npm run setup in a terminal.');
  output.write('Paste only the value for each cookie below, then press Enter. Input is visible. Ctrl+C cancels.\n');
  const names = ['__Secure-next-auth.session-token.0', '__Secure-next-auth.session-token.1'];
  const values: string[] = [];
  const wasRaw = input.isRaw;
  const reader = createLineReader({ input, output, terminal: true, historySize: 0, crlfDelay: Infinity });
  try {
    return await new Promise<string>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error, value = '') => {
        if (finished) return;
        finished = true;
        if (error) reject(error);
        else resolve(value);
      };
      const prompt = () => {
        reader.setPrompt(`${names[values.length]}: `);
        reader.prompt();
      };
      reader.on('line', line => {
        if (finished) return;
        const value = line.trim();
        if (line.length + values.join('').length + names.join('').length + 4 > 262_144) {
          finish(new Error('Cookie input exceeds 256 KiB.')); return;
        }
        if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
          output.write('Paste only the cookie value; it cannot be empty or include the cookie name.\n');
          prompt(); return;
        }
        values.push(value);
        if (values.length === names.length) {
          finish(undefined, names.map((name, index) => `${name}=${values[index]}`).join(', '));
        } else prompt();
      });
      reader.on('SIGINT', () => finish(new Error('Cookie entry cancelled.')));
      reader.on('close', () => finish(new Error('Cookie entry ended before Enter. Nothing was imported.')));
      reader.on('error', () => finish(new Error('Unable to read cookie input.')));
      prompt();
    });
  } finally {
    reader.close();
    input.setRawMode(wasRaw ?? false);
    input.pause();
  }
}
