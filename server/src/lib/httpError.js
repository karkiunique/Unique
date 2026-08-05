/**
 * Small helper so services can signal an HTTP status without importing Express.
 *
 * `expose` marks the message as safe to return to the caller: it is written by us
 * and never contains email content, tokens or OAuth codes. Errors from third-party
 * SDKs also carry a `status`, so routes must check `expose` before echoing a message.
 */
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

/** The message to send back, or a generic fallback for anything not ours. */
export function safeMessage(err, fallback) {
  const status = Number(err?.status) || 500;
  return err?.expose === true && status < 500 ? err.message : fallback;
}
