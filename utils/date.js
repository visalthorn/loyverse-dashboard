const dayjs    = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'Asia/Phnom_Penh';

// "Today" on the Cambodia calendar, independent of the DB server's timezone.
// Supabase (PROD) runs at UTC, so bare CURRENT_DATE is a day behind Cambodia
// between 00:00 and 07:00 local — every period preset must use this instead.
const KH_TODAY = `(NOW() AT TIME ZONE '${TZ}')::date`;

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
    case 'today':     return { clause: `DATE(${col}) = ${KH_TODAY}`, params: [] };
    case 'yesterday': return { clause: `DATE(${col}) = ${KH_TODAY} - INTERVAL '1 day'`, params: [] };
    case 'week':   return { clause: `DATE(${col}) BETWEEN ${KH_TODAY} - INTERVAL '7 days' AND ${KH_TODAY}`, params: [] };
    case 'last10': return { clause: `DATE(${col}) BETWEEN ${KH_TODAY} - INTERVAL '10 days' AND ${KH_TODAY}`, params: [] };
    case 'month':  return { clause: `DATE_TRUNC('month', ${col}) = DATE_TRUNC('month', ${KH_TODAY} - INTERVAL '1 month')`, params: [] };
    case 'year':   return { clause: `DATE_TRUNC('year', ${col}) = DATE_TRUNC('year', ${KH_TODAY} - INTERVAL '1 year')`, params: [] };
    default:       return { clause: `DATE(${col}) = ${KH_TODAY}`, params: [] };
  }
}

function getTrendPeriod(period, startDate, endDate) {
  if (period === 'year') return 'month';
  if (period === 'week' || period === 'last10' || period === 'month' || period === 'yesterday') return 'day';
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
    case 'yesterday':
      return { clause: `DATE(${col}) = ${KH_TODAY} - INTERVAL '2 day'`, params: [] };
    case 'week':
      return { clause: `DATE(${col}) BETWEEN ${KH_TODAY} - INTERVAL '13 days' AND ${KH_TODAY} - INTERVAL '7 days'`, params: [] };
    case 'last10':
      return { clause: `DATE(${col}) BETWEEN ${KH_TODAY} - INTERVAL '20 days' AND ${KH_TODAY} - INTERVAL '10 days'`, params: [] };
    case 'month':
      return { clause: `DATE_TRUNC('month', ${col}) = DATE_TRUNC('month', ${KH_TODAY} - INTERVAL '2 months')`, params: [] };
    case 'year':
      return { clause: `DATE_TRUNC('year', ${col}) = DATE_TRUNC('year', ${KH_TODAY} - INTERVAL '2 years')`, params: [] };
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
      return { clause: `DATE(${col}) = ${KH_TODAY} - INTERVAL '2 day'`, params: [] };
    default:
      return { clause: `DATE(${col}) = ${KH_TODAY} - INTERVAL '2 day'`, params: [] };
  }
}

function growth(current, previous) {
  if (!previous || previous == 0) return 0;
  return parseFloat((((current - previous) / previous) * 100).toFixed(1));
}

// Exact start/end dates for the current period (used by generate_series daily-avg query)
function getPeriodDateRange(period, startDate, endDate) {
  if (startDate && endDate) return { start: startDate, end: endDate };
  const now = dayjs().tz(TZ);
  switch (period) {
    case 'today': {
      const d = now.format('YYYY-MM-DD');
      return { start: d, end: d };
    }
    case 'yesterday': {
      const d = now.subtract(1, 'day').format('YYYY-MM-DD');
      return { start: d, end: d };
    }
    case 'week':
      return { start: now.subtract(7, 'day').format('YYYY-MM-DD'), end: now.format('YYYY-MM-DD') };
    case 'last10':
      return { start: now.subtract(10, 'day').format('YYYY-MM-DD'), end: now.format('YYYY-MM-DD') };
    case 'month': {
      const m = now.subtract(1, 'month');
      return { start: m.startOf('month').format('YYYY-MM-DD'), end: m.endOf('month').format('YYYY-MM-DD') };
    }
    case 'year': {
      const y = now.subtract(1, 'year');
      return { start: y.startOf('year').format('YYYY-MM-DD'), end: y.endOf('year').format('YYYY-MM-DD') };
    }
    default: {
      const d = now.format('YYYY-MM-DD');
      return { start: d, end: d };
    }
  }
}

// Exact start/end dates for the previous comparison period
function getPrevPeriodDateRange(period, startDate, endDate) {
  const now = dayjs().tz(TZ);
  switch (period) {
    case 'today': {
      const d = now.subtract(1, 'day').format('YYYY-MM-DD');
      return { start: d, end: d };
    }
    case 'yesterday': {
      const d = now.subtract(2, 'day').format('YYYY-MM-DD');
      return { start: d, end: d };
    }
    case 'week':
      return {
        start: now.subtract(13, 'day').format('YYYY-MM-DD'),
        end:   now.subtract(7,  'day').format('YYYY-MM-DD'),
      };
    case 'last10':
      return {
        start: now.subtract(20, 'day').format('YYYY-MM-DD'),
        end:   now.subtract(10, 'day').format('YYYY-MM-DD'),
      };
    case 'month': {
      const m = now.subtract(2, 'month');
      return { start: m.startOf('month').format('YYYY-MM-DD'), end: m.endOf('month').format('YYYY-MM-DD') };
    }
    case 'year': {
      const y = now.subtract(2, 'year');
      return { start: y.startOf('year').format('YYYY-MM-DD'), end: y.endOf('year').format('YYYY-MM-DD') };
    }
    case 'range': {
      if (startDate && endDate) {
        const s    = dayjs(startDate);
        const e    = dayjs(endDate);
        const days = e.diff(s, 'day') + 1;
        const prevEnd   = s.subtract(1, 'day');
        const prevStart = prevEnd.subtract(days - 1, 'day');
        return { start: prevStart.format('YYYY-MM-DD'), end: prevEnd.format('YYYY-MM-DD') };
      }
      const d = now.subtract(1, 'day').format('YYYY-MM-DD');
      return { start: d, end: d };
    }
    default: {
      const d = now.subtract(1, 'day').format('YYYY-MM-DD');
      return { start: d, end: d };
    }
  }
}

module.exports = {
  toCambodiaTime,
  buildPeriodFilter, getTrendPeriod, getPrevPeriodSQL,
  getPeriodDateRange, getPrevPeriodDateRange,
  growth,
};
