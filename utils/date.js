const dayjs    = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'Asia/Phnom_Penh';

function toCambodiaTime(date) {
  if (!date) return null;
  return dayjs.utc(date).tz(TZ).format('YYYY-MM-DD HH:mm:ss');
}

function buildPeriodFilter(period, startDate, endDate, alias = 'r', firstParam = 1, colName = 'receipt_date') {
  const col = `${alias}.${colName}`;
  if (startDate && endDate) {
    return { clause: `DATE(${col}) BETWEEN $${firstParam} AND $${firstParam + 1}`, params: [startDate, endDate] };
  }
  if (startDate) {
    return { clause: `DATE(${col}) >= $${firstParam}`, params: [startDate] };
  }
  if (endDate) {
    return { clause: `DATE(${col}) <= $${firstParam}`, params: [endDate] };
  }
  switch (period) {
    case 'today': return { clause: `DATE(${col}) = CURRENT_DATE`, params: [] };
    case 'week':  return { clause: `DATE(${col}) BETWEEN CURRENT_DATE - INTERVAL '7 days' AND CURRENT_DATE`, params: [] };
    case 'month': return { clause: `DATE_TRUNC('month', ${col}) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')`, params: [] };
    case 'year':  return { clause: `DATE_TRUNC('year', ${col}) = DATE_TRUNC('year', CURRENT_DATE - INTERVAL '1 year')`, params: [] };
    default:      return { clause: `DATE(${col}) = CURRENT_DATE`, params: [] };
  }
}

function getTrendPeriod(period, startDate, endDate) {
  if (period === 'year') return 'month';
  if (period === 'week' || period === 'month') return 'day';
  if (period === 'range' && startDate && endDate) {
    const days = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1);
    if (days <= 31)  return 'day';
    if (days <= 180) return 'week';
    return 'month';
  }
  return 'day';
}

function getPrevPeriodSQL(period, startDate, endDate, alias = 'r', colName = 'receipt_date') {
  const col = `${alias}.${colName}`;
  switch (period) {
    case 'week':
      return { clause: `DATE(${col}) BETWEEN CURRENT_DATE - INTERVAL '13 days' AND CURRENT_DATE - INTERVAL '7 days'`, params: [] };
    case 'month':
      return { clause: `DATE_TRUNC('month', ${col}) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '2 months')`, params: [] };
    case 'year':
      return { clause: `DATE_TRUNC('year', ${col}) = DATE_TRUNC('year', CURRENT_DATE - INTERVAL '2 years')`, params: [] };
    case 'range':
      if (startDate && endDate) {
        const start     = dayjs(startDate).startOf('day');
        const end       = dayjs(endDate).startOf('day');
        const days      = Math.max(1, end.diff(start, 'day') + 1);
        const prevEnd   = start.subtract(1, 'day');
        const prevStart = prevEnd.subtract(days - 1, 'day');
        return {
          clause: `DATE(${col}) BETWEEN $1 AND $2`,
          params: [prevStart.format('YYYY-MM-DD'), prevEnd.format('YYYY-MM-DD')],
        };
      }
      return { clause: `DATE(${col}) = CURRENT_DATE - INTERVAL '2 day'`, params: [] };
    default:
      return { clause: `DATE(${col}) = CURRENT_DATE - INTERVAL '2 day'`, params: [] };
  }
}

function growth(current, previous) {
  if (!previous || previous == 0) return 0;
  return parseFloat((((current - previous) / previous) * 100).toFixed(1));
}

function isLeapYear(yr) {
  return yr % 4 === 0 && (yr % 100 !== 0 || yr % 400 === 0);
}

// Number of calendar days covered by the current-period SQL filter
function getPeriodDays(period, startDate, endDate) {
  if (startDate && endDate) {
    return Math.max(1, dayjs(endDate).diff(dayjs(startDate), 'day') + 1);
  }
  switch (period) {
    case 'today': return 1;
    case 'week':  return 7;
    case 'month': return dayjs().subtract(1, 'month').daysInMonth();
    case 'year': {
      const yr = dayjs().subtract(1, 'year').year();
      return isLeapYear(yr) ? 366 : 365;
    }
    default: return 1;
  }
}

// Number of calendar days covered by the previous-period SQL filter
function getPrevPeriodDays(period, startDate, endDate) {
  if (startDate && endDate) {
    return Math.max(1, dayjs(endDate).diff(dayjs(startDate), 'day') + 1);
  }
  switch (period) {
    case 'today': return 1;
    case 'week':  return 7;
    case 'month': return dayjs().subtract(2, 'month').daysInMonth();
    case 'year': {
      const yr = dayjs().subtract(2, 'year').year();
      return isLeapYear(yr) ? 366 : 365;
    }
    default: return 1;
  }
}

module.exports = { toCambodiaTime, buildPeriodFilter, getTrendPeriod, getPrevPeriodSQL, getPeriodDays, getPrevPeriodDays, growth };
