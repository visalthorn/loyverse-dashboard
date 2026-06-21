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

function getPrevPeriodSQL(period, startDate, endDate, alias = 'r') {
  const col = `${alias}.receipt_date`;
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

module.exports = { toCambodiaTime, buildPeriodFilter, getTrendPeriod, getPrevPeriodSQL, growth };
