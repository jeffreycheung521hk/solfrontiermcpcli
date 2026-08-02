// One number, one meaning. Scripts branch on this; the contract is stable.
export const EXIT = {
  OK: 0, // the command did what was asked
  FAILED: 1, // it ran and the answer is negative (tool error, not-found, no-go)
  USAGE: 2, // the caller is wrong: bad flags, missing args, refused by guardrail
  TRANSPORT: 3, // machinery broke: spawn failed, protocol error, server died
  TIMEOUT: 4, // machinery is fine but too slow: a deadline expired
  INTERRUPTED: 130, // Ctrl-C (128 + SIGINT), the POSIX convention
};

/** Base for errors that carry their own exit code. */
export class CliError extends Error {
  constructor(message, exitCode = EXIT.FAILED, details = undefined) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class UsageError extends CliError {
  constructor(message, details) {
    super(message, EXIT.USAGE, details);
  }
}

export class GuardrailError extends CliError {
  constructor(message, details) {
    super(message, EXIT.USAGE, details);
    this.guardrail = true;
  }
}

export class TransportError extends CliError {
  constructor(message, details) {
    super(message, EXIT.TRANSPORT, details);
  }
}

export class TimeoutError extends CliError {
  constructor(message, details) {
    super(message, EXIT.TIMEOUT, details);
  }
}
