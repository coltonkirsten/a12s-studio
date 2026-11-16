// A refusal the caller can act on: `code` for programs, `message` and `fix` for the agent or the owner, `status`
// for the HTTP listeners.
export class StudioError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fix: string | undefined;
  constructor(status: number, code: string, message: string, fix?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.fix = fix;
  }

  toJSON(): { code: string; message: string; fix?: string } {
    return { code: this.code, message: this.message, ...(this.fix === undefined ? {} : { fix: this.fix }) };
  }
}
