/**
 * Companion employee emails are generated from dashboard usernames, which may
 * themselves contain "@" (e.g. "ismail@pawm"). Sanitise the local part so the
 * generated address is always accepted by the employee validation schema.
 */
export function employeeEmailForUsername(username) {
  const local = String(username ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "")
    .toLowerCase();
  return `${local || "staff"}@paw-m.local`;
}
