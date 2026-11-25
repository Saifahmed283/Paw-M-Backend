/** Shared presentation helpers for staff cash withdrawal requests. */

export function employeeNameMap(employees = []) {
  return new Map(employees.map((employee) => [employee.id, employee.fullName]));
}

export function mapCashWithdrawal(row, names = new Map()) {
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    note: row.note,
    status: row.status,
    requestedBy: row.requestedBy,
    requesterUsername: row.requester?.username ?? "",
    employeeId: row.employeeId ?? null,
    employeeName: row.employeeId ? names.get(row.employeeId) ?? row.employeeId : null,
    workSessionId: row.workSessionId ?? null,
    reviewNote: row.reviewNote ?? "",
    reviewedBy: row.reviewedBy ?? null,
    reviewerUsername: row.reviewer?.username ?? null,
    reviewedAt: row.reviewedAt ?? null,
    createdAt: row.createdAt,
  };
}
