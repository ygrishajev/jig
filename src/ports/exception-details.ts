/** What jig reads from a thrown value, which JavaScript lets be anything, not only an `Error`. */
export interface ExceptionDetails {
  messageOf(error: unknown): string;
  /** What was first thrown under a chain of panics, such as the one `Result.gen` wraps around a throw. */
  rootCause(error: unknown): unknown;
}
