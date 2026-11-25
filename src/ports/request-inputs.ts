/** Where a command's request text comes from; each is read only once the command needs it. */
export interface RequestInputs {
  cwd(): string;
  standardInput(): StandardInput;
  /** Rejects as `fs.readFile` does when the file cannot be read. */
  readTextFile(file: string): Promise<string>;
}

/** What the CLI reads piped in from the shell; a terminal has nothing piped to read. */
export interface StandardInput {
  isTerminal: boolean;
  readAll(): Promise<string>;
}
