// Stable error codes shared across the API. The client re-emits `code` verbatim,
// and TEST_SPEC asserts on these, so treat them as a contract.
export type ErrorCode =
  | "invalid_argument"
  | "template_not_found"
  | "session_not_found"
  | "session_not_active"
  | "unsupported_on_platform"
  | "install_failed"
  | "artifact_not_found"
  | "build_not_found"
  | "build_failed"
  | "project_not_found";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_argument: 400,
  template_not_found: 404,
  session_not_found: 404,
  session_not_active: 409,
  unsupported_on_platform: 400,
  install_failed: 422,
  artifact_not_found: 404,
  build_not_found: 404,
  build_failed: 422,
  project_not_found: 400,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
  }
}

export function errorBody(err: unknown): {
  error: { code: string; message: string };
} {
  if (err instanceof AppError) {
    return { error: { code: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: "internal_error", message } };
}
