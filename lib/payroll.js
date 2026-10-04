// Monthly payroll calculation. Overtime follows Kepmenakertrans 102/2004 for workdays:
// hourly wage = monthly wage / 173; first overtime hour x1.5, every following hour x2.

const HOURS_PER_MONTH = 173;

function overtimePay(minutes, hourlyRate) {
  const hours = minutes / 60;
  return hourlyRate * (1.5 * Math.min(hours, 1) + 2 * Math.max(hours - 1, 0));
}

function computePayslip({ salary, attendance, overtime, cashAdvances }) {
  const base = Number(salary?.base) || 0;
  const allowance = Number(salary?.allowance) || 0;
  const otherDeduction = Number(salary?.deduction) || 0;
  const hourlyRate = Number(salary?.overtimeRate) || base / HOURS_PER_MONTH;

  const overtimeLines = overtime.map((o) => ({
    id: o.id,
    date: o.date,
    start: o.start,
    end: o.end,
    minutes: o.minutes,
    corrected: !!o.correctedFrom,
    pay: Math.round(overtimePay(o.minutes, hourlyRate)),
  }));
  const overtimeTotal = overtimeLines.reduce((s, l) => s + l.pay, 0);
  const overtimeMinutes = overtimeLines.reduce((s, l) => s + l.minutes, 0);
  const cashAdvanceTotal = cashAdvances.reduce((s, c) => s + Number(c.amount), 0);

  const gross = base + allowance + overtimeTotal;
  const deductions = cashAdvanceTotal + otherDeduction;
  return {
    configured: !!salary,
    base,
    allowance,
    hourlyRate: Math.round(hourlyRate),
    presentDays: attendance.length,
    overtimeLines,
    overtimeMinutes,
    overtimeTotal,
    cashAdvances: cashAdvances.map((c) => ({ id: c.id, amount: Number(c.amount), reason: c.reason })),
    cashAdvanceTotal,
    otherDeduction,
    gross,
    deductions,
    net: gross - deductions,
  };
}

// Pulls the month's inputs for one user out of the store.
function payslipFor(store, userId, month) {
  return computePayslip({
    salary: store.find('salaries', (s) => s.userId === userId),
    attendance: store.filter('attendance', (a) => a.userId === userId && a.date.startsWith(month)),
    overtime: store.filter('overtime', (o) => o.userId === userId && o.status === 'approved' && o.date.startsWith(month)),
    cashAdvances: store.filter('cashAdvances', (c) => c.userId === userId && c.status === 'approved' && c.deductMonth === month),
  });
}

module.exports = { HOURS_PER_MONTH, overtimePay, computePayslip, payslipFor };
