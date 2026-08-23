/**
 * Decision logger. Every strategy decision, reactive action and race event
 * is recorded here as one JSON object per line, both to a .jsonl file and
 * (configurably) to stdout. The file path defaults to a timestamped file in
 * the log/ directory.
 */
import fs from 'node:fs';
import path from 'node:path';

export class DecisionLogger {
  /**
   * @param {object} opts
   * @param {string} [opts.file]   log file path (created if missing)
   * @param {boolean} [opts.stdout] mirror entries to stdout (default: true)
   */
  constructor({ file, stdout = true } = {}) {
    this.file = file ?? null;
    this.toStdout = stdout;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, ''); // start fresh each run
      this.fd = fs.openSync(this.file, 'a');
    }
  }

  /** Log one event object. */
  log(event) {
    const line = JSON.stringify(event);
    if (this.fd !== undefined) {
      fs.writeSync(this.fd, line + '\n');
    }
    if (this.toStdout) {
      process.stdout.write(line + '\n');
    }
  }

  close() {
    if (this.fd !== undefined) {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
  }
}
