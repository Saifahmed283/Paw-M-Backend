/**
 * Postgres foreign-key failures reach Prisma in a few different shapes:
 * P2003/P2014 for known cases, and a raw connector error (code 23001/23503)
 * for ON DELETE RESTRICT violations. Treat all of them as one case so delete
 * handlers can return a clear 409 instead of a generic 500.
 */
export function isForeignKeyConstraintError(error) {
  if (!error) return false;
  if (error.code === "P2003" || error.code === "P2014") return true;

  const message = `${error.message ?? ""} ${JSON.stringify(error.meta ?? {})}`;
  return /foreign key constraint|violates RESTRICT|violates foreign key/i.test(message);
}
