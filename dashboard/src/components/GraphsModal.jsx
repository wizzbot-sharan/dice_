import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  X, 
  Calendar, 
  BarChart2, 
  Users, 
  Globe, 
  Info,
  Clock,
  TrendingUp
} from 'lucide-react';
import { format, parseISO, startOfMonth } from 'date-fns';

// Zero-fill missing calendar days without UTC timezone shifting
function fillDateGaps(rows, startStr, endStr) {
  if (!startStr || !endStr) return rows || [];
  const map = new Map();
  (rows || []).forEach(r => map.set(r.day, {
    count: Number(r.count) || 0,
    clients: Number(r.clients) || Number(r.client_count) || 0
  }));

  const result = [];
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  let curr = new Date(sy, sm - 1, sd, 12, 0, 0); // Noon avoids DST & UTC offset shifts
  const end = new Date(ey, em - 1, ed, 12, 0, 0);

  while (curr <= end) {
    const y = curr.getFullYear();
    const m = String(curr.getMonth() + 1).padStart(2, '0');
    const d = String(curr.getDate()).padStart(2, '0');
    const dayStr = `${y}-${m}-${d}`;
    const entry = map.get(dayStr);
    result.push({
      day: dayStr,
      count: entry ? entry.count : 0,
      clients: entry ? entry.clients : 0
    });
    curr.setDate(curr.getDate() + 1);
  }
  return result;
}

// Current date formatted in target timezone
function getTodayInTz(tz) {
  const map = {
    IST: 'Asia/Kolkata',
    UTC: 'UTC',
    EST: 'America/New_York',
    CST: 'America/Chicago',
    PST: 'America/Los_Angeles'
  };
  const iana = map[tz] || 'Asia/Kolkata';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: iana,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export default function GraphsModal({ isOpen, onClose, selectedTz = 'IST' }) {
  const [showLabels, setShowLabels] = useState(true);

  const todayStr = useMemo(() => getTodayInTz(selectedTz), [selectedTz]);
  const monthStartStr = useMemo(() => {
    try {
      const d = parseISO(todayStr);
      return format(startOfMonth(d), 'yyyy-MM-dd');
    } catch {
      return todayStr.slice(0, 8) + '01';
    }
  }, [todayStr]);

  const [fromDate, setFromDate] = useState(monthStartStr);
  const [toDate, setToDate] = useState(todayStr);
  const [hourlyDate, setHourlyDate] = useState(todayStr);

  const [dailyData, setDailyData] = useState([]);
  const [loadingDaily, setLoadingDaily] = useState(false);
  const [dailyError, setDailyError] = useState('');

  const [hourlyData, setHourlyData] = useState([]);
  const [loadingHourly, setLoadingHourly] = useState(false);
  const [hourlyError, setHourlyError] = useState('');

  const [hoveredBar, setHoveredBar] = useState(null);
  const [hoveredHour, setHoveredHour] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    setFromDate(monthStartStr);
    setToDate(todayStr);
    setHourlyDate(todayStr);
  }, [selectedTz, monthStartStr, todayStr]);

  // Fetch daily histogram
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const fetchDaily = async () => {
      setLoadingDaily(true);
      setDailyError('');
      try {
        let url = `/api/analytics/daily?tz=${encodeURIComponent(selectedTz)}&_t=${Date.now()}`;
        if (fromDate && toDate) {
          url += `&from=${fromDate} 00:00:00&to=${toDate} 23:59:59`;
        }
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setDailyData(fillDateGaps(data, fromDate, toDate));
        }
      } catch (err) {
        if (!cancelled) setDailyError(err.message || 'Failed to load daily analytics');
      } finally {
        if (!cancelled) setLoadingDaily(false);
      }
    };

    fetchDaily();
    return () => { cancelled = true; };
  }, [isOpen, fromDate, toDate, selectedTz]);

  // Fetch hourly distribution
  useEffect(() => {
    if (!isOpen || !hourlyDate) return;
    let cancelled = false;

    const fetchHourly = async () => {
      setLoadingHourly(true);
      setHourlyError('');
      try {
        const url = `/api/analytics/hourly?date=${encodeURIComponent(hourlyDate)}&tz=${encodeURIComponent(selectedTz)}&_t=${Date.now()}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setHourlyData(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        if (!cancelled) setHourlyError(err.message || 'Failed to load hourly analytics');
      } finally {
        if (!cancelled) setLoadingHourly(false);
      }
    };

    fetchHourly();
    return () => { cancelled = true; };
  }, [isOpen, hourlyDate, selectedTz]);

  // Metrics
  const totalDailyCompleted = useMemo(() => {
    return dailyData.reduce((acc, curr) => acc + (curr.count || 0), 0);
  }, [dailyData]);

  const peakDailyClients = useMemo(() => {
    return Math.max(0, ...dailyData.map(d => d.clients || 0));
  }, [dailyData]);

  const dailyAvg = useMemo(() => {
    if (dailyData.length === 0) return 0;
    return (totalDailyCompleted / dailyData.length).toFixed(1);
  }, [totalDailyCompleted, dailyData]);

  const totalHourlyJobs = useMemo(() => {
    return hourlyData.reduce((acc, curr) => acc + (curr.count || 0), 0);
  }, [hourlyData]);

  const peakHourlyClients = useMemo(() => {
    return Math.max(0, ...hourlyData.map(d => d.clients || 0));
  }, [hourlyData]);

  const handleQuickRange = (type) => {
    if (type === 'month') {
      setFromDate(monthStartStr);
      setToDate(todayStr);
    } else if (type === '14d') {
      const d = parseISO(todayStr);
      d.setDate(d.getDate() - 13);
      setFromDate(format(d, 'yyyy-MM-dd'));
      setToDate(todayStr);
    } else if (type === '30d') {
      const d = parseISO(todayStr);
      d.setDate(d.getDate() - 29);
      setFromDate(format(d, 'yyyy-MM-dd'));
      setToDate(todayStr);
    }
  };

  const handleQuickHourly = (type) => {
    if (type === 'today') {
      setHourlyDate(todayStr);
    } else if (type === 'yesterday') {
      const d = parseISO(todayStr);
      d.setDate(d.getDate() - 1);
      setHourlyDate(format(d, 'yyyy-MM-dd'));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-[#09090b]/98 backdrop-blur-xl overflow-y-auto text-zinc-100 flex flex-col p-3 sm:p-5 animate-in fade-in duration-150">
      
      {/* Top Compact Navigation Header */}
      <div className="max-w-7xl w-full mx-auto flex items-center justify-between pb-3 border-b border-zinc-800/80 shrink-0">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-zinc-800/90 hover:bg-zinc-700 active:scale-95 text-zinc-300 hover:text-white border border-zinc-700/80 flex items-center justify-center transition-all cursor-pointer shadow group"
            title="Close (Esc)"
          >
            <X className="w-4 h-4 transition-transform group-hover:scale-110" />
          </button>
          
          <div className="flex items-center gap-2">
            <span className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              <BarChart2 className="w-4 h-4" />
            </span>
            <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white">
              Automation Performance Analytics
            </h1>
          </div>
        </div>

        {/* Header Right Badges */}
        <div className="flex items-center gap-2.5">
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300">
            <Globe className="w-3.5 h-3.5 text-blue-400" />
            <span className="font-semibold text-zinc-300">TZ:</span>
            <span className="font-mono text-emerald-400 font-bold">{selectedTz}</span>
          </div>

          <button
            type="button"
            onClick={() => setShowLabels(!showLabels)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
              showLabels
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
            }`}
            title="Toggle data labels permanently above each bar and point"
          >
            <span className={`w-2 h-2 rounded-full ${showLabels ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            <span>Labels: <strong>{showLabels ? 'ON' : 'OFF'}</strong></span>
          </button>
        </div>
      </div>

      {/* Main Charts Body */}
      <div className="max-w-7xl w-full mx-auto flex-1 flex flex-col gap-4 py-4">
        
        {/* ============================================================== */}
        {/* 1. DAILY COMPLETED JOBS & CLIENT OVERLAY (HISTOGRAM)          */}
        {/* ============================================================== */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-4 shadow-lg flex flex-col gap-3">
          
          {/* Header Controls */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 pb-2.5 border-b border-zinc-800/60">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                <h2 className="text-sm sm:text-base font-bold text-white tracking-tight">
                  Daily Completed Jobs & Active Clients
                </h2>
              </div>

              {/* Chart Legend */}
              <div className="flex items-center gap-3 text-[11px] bg-zinc-950/80 border border-zinc-800 px-2.5 py-0.5 rounded-lg">
                <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
                  <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" />
                  Completed Jobs (Bar)
                </span>
                <span className="flex items-center gap-1.5 text-violet-400 font-medium">
                  <span className="w-2 h-2 rounded-full bg-violet-400 inline-block" />
                  Active Clients (Line)
                </span>
              </div>
            </div>

            {/* Range Controls & Summary Badges */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => handleQuickRange('month')}
                  className="px-2 py-0.5 rounded hover:bg-zinc-800 font-medium text-zinc-300 transition-colors"
                >
                  This Month
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickRange('14d')}
                  className="px-2 py-0.5 rounded hover:bg-zinc-800 font-medium text-zinc-300 transition-colors"
                >
                  Last 14D
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickRange('30d')}
                  className="px-2 py-0.5 rounded hover:bg-zinc-800 font-medium text-zinc-300 transition-colors"
                >
                  Last 30D
                </button>
              </div>

              {/* Date Pickers */}
              <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-0.5 text-xs">
                <Calendar className="w-3.5 h-3.5 text-zinc-500" />
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="bg-transparent text-zinc-200 outline-none text-xs"
                />
                <span className="text-zinc-600">to</span>
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="bg-transparent text-zinc-200 outline-none text-xs"
                />
              </div>

              {/* Summary Stats */}
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <div className="px-2.5 py-0.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                  Jobs: <strong className="text-white">{totalDailyCompleted.toLocaleString()}</strong>
                </div>
                <div className="px-2.5 py-0.5 rounded-lg bg-violet-500/10 border border-violet-500/30 text-violet-400">
                  Peak Clients: <strong className="text-white">{peakDailyClients}</strong>
                </div>
                <div className="px-2.5 py-0.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300">
                  Avg: <strong className="text-white">{dailyAvg}/day</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Histogram Chart */}
          <div className="w-full relative min-h-[220px] flex items-center justify-center">
            {loadingDaily ? (
              <div className="flex items-center gap-2 text-zinc-400 text-xs py-12 animate-pulse">
                <div className="w-3.5 h-3.5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                Loading daily performance...
              </div>
            ) : dailyError ? (
              <div className="text-rose-400 text-xs py-8">{dailyError}</div>
            ) : dailyData.length === 0 ? (
              <div className="text-zinc-500 text-xs py-10">No completed jobs found for this range.</div>
            ) : (
              <HistogramOverlayChart 
                data={dailyData} 
                showLabels={showLabels}
                selectedDate={hourlyDate}
                onSelectDate={(day) => setHourlyDate(day)}
                hoveredBar={hoveredBar}
                setHoveredBar={setHoveredBar}
              />
            )}
          </div>
        </div>

        {/* ============================================================== */}
        {/* 2. HOURLY DISTRIBUTION & CLIENT OVERLAY (CURVE GRAPH)         */}
        {/* ============================================================== */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-4 shadow-lg flex flex-col gap-3">
          
          {/* Header Controls */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 pb-2.5 border-b border-zinc-800/60">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
                <h2 className="text-sm sm:text-base font-bold text-white tracking-tight">
                  24-Hour Distribution for {hourlyDate}
                </h2>
              </div>

              {/* Chart Legend */}
              <div className="flex items-center gap-3 text-[11px] bg-zinc-950/80 border border-zinc-800 px-2.5 py-0.5 rounded-lg">
                <span className="flex items-center gap-1.5 text-cyan-400 font-medium">
                  <span className="w-2.5 h-2 rounded-full bg-cyan-400 inline-block" />
                  Completed Jobs
                </span>
                <span className="flex items-center gap-1.5 text-violet-400 font-medium">
                  <span className="w-2 h-2 rounded-full bg-violet-400 inline-block" />
                  Active Clients
                </span>
              </div>
            </div>

            {/* Hourly Target Controls & Stats */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => handleQuickHourly('today')}
                  className={`px-2.5 py-0.5 rounded font-medium transition-colors ${
                    hourlyDate === todayStr ? 'bg-cyan-500/20 text-cyan-300' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickHourly('yesterday')}
                  className="px-2.5 py-0.5 rounded text-zinc-400 hover:text-zinc-200 font-medium transition-colors"
                >
                  Yesterday
                </button>
              </div>

              <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-0.5 text-xs">
                <Clock className="w-3.5 h-3.5 text-cyan-400" />
                <input
                  type="date"
                  value={hourlyDate}
                  onChange={(e) => setHourlyDate(e.target.value)}
                  className="bg-transparent text-zinc-200 outline-none text-xs font-medium cursor-pointer"
                />
              </div>

              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <div className="px-2.5 py-0.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                  Total: <strong className="text-white">{totalHourlyJobs}</strong>
                </div>
                <div className="px-2.5 py-0.5 rounded-lg bg-violet-500/10 border border-violet-500/30 text-violet-400">
                  Peak Clients: <strong className="text-white">{peakHourlyClients}</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Hourly Curve Chart */}
          <div className="w-full relative min-h-[220px] flex items-center justify-center">
            {loadingHourly ? (
              <div className="flex items-center gap-2 text-zinc-400 text-xs py-12 animate-pulse">
                <div className="w-3.5 h-3.5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                Loading hourly distribution...
              </div>
            ) : hourlyError ? (
              <div className="text-rose-400 text-xs py-8">{hourlyError}</div>
            ) : hourlyData.length === 0 ? (
              <div className="text-zinc-500 text-xs py-10">No hourly activity recorded on this date.</div>
            ) : (
              <HourlyCurveOverlayChart 
                data={hourlyData} 
                showLabels={showLabels}
                hoveredHour={hoveredHour}
                setHoveredHour={setHoveredHour}
                selectedTz={selectedTz}
              />
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

// =========================================================================
// SUBCOMPONENT: HISTOGRAM OVERLAY CHART (Lightweight SVG, Dual Metric)
// =========================================================================
function HistogramOverlayChart({ data, showLabels, selectedDate, onSelectDate, hoveredBar, setHoveredBar }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(1000);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) setWidth(Math.max(600, entries[0].contentRect.width));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const height = 210;
  const padding = { top: 28, right: 35, bottom: 35, left: 45 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxJobs = Math.max(5, ...data.map(d => d.count || 0));
  const roundedMaxJobs = Math.ceil(maxJobs * 1.2);

  const maxClients = Math.max(1, ...data.map(d => d.clients || 0));
  const roundedMaxClients = Math.ceil(maxClients * 1.25);

  const getYJobs = (val) => chartH - (val / roundedMaxJobs) * chartH;
  const getYClients = (val) => chartH - (val / roundedMaxClients) * chartH;
  const getX = (idx) => padding.left + (idx + 0.5) * (chartW / data.length);

  const barWidth = Math.max(8, Math.min(26, (chartW / data.length) * 0.55));

  // Build client overlay line points
  const clientPoints = data.map((item, idx) => ({
    x: getX(idx),
    y: padding.top + getYClients(item.clients || 0),
    clients: item.clients || 0,
    count: item.count || 0,
    day: item.day
  }));

  const clientLinePath = clientPoints.reduce((acc, pt, i) => {
    return i === 0 ? `M ${pt.x} ${pt.y}` : `${acc} L ${pt.x} ${pt.y}`;
  }, '');

  return (
    <div ref={containerRef} className="w-full overflow-x-auto select-none">
      <svg width={width} height={height} className="overflow-visible">
        {/* Horizontal Grid lines (Jobs scale on Left) */}
        {[0, 0.5, 1].map((pct, i) => {
          const yJobVal = Math.round(roundedMaxJobs * pct);
          const yClientVal = Math.round(roundedMaxClients * pct);
          const yPos = padding.top + getYJobs(yJobVal);

          return (
            <g key={i}>
              <line
                x1={padding.left}
                y1={yPos}
                x2={width - padding.right}
                y2={yPos}
                stroke="#27272a"
                strokeDasharray={pct === 0 ? '0' : '3 3'}
              />
              {/* Left Y Axis: Jobs */}
              <text
                x={padding.left - 6}
                y={yPos + 3}
                textAnchor="end"
                className="text-[10px] fill-zinc-500 font-mono"
              >
                {yJobVal}
              </text>
              {/* Right Y Axis: Clients */}
              <text
                x={width - padding.right + 6}
                y={yPos + 3}
                textAnchor="start"
                className="text-[10px] fill-violet-400/80 font-mono"
              >
                {yClientVal}c
              </text>
            </g>
          );
        })}

        {/* Bars (Completed Jobs) */}
        {data.map((item, idx) => {
          const x = getX(idx) - barWidth / 2;
          const barH = (item.count / roundedMaxJobs) * chartH;
          const y = padding.top + getYJobs(item.count);
          const isSelected = item.day === selectedDate;
          const isHovered = hoveredBar?.day === item.day;

          let labelStr = item.day.slice(5);
          try {
            labelStr = format(parseISO(item.day), 'MMM d');
          } catch {}

          return (
            <g 
              key={item.day}
              className="cursor-pointer"
              onClick={() => onSelectDate(item.day)}
              onMouseEnter={() => {
                setHoveredBar({
                  day: item.day,
                  count: item.count,
                  clients: item.clients || 0,
                  x: x + barWidth / 2,
                  y: y - 10
                });
              }}
              onMouseLeave={() => setHoveredBar(null)}
            >
              {/* Interactive Hit Area */}
              <rect
                x={x - 4}
                y={padding.top}
                width={barWidth + 8}
                height={chartH}
                fill="transparent"
              />

              {/* Bar */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(3, barH)}
                rx={4}
                ry={4}
                fill={isSelected ? '#34d399' : '#10b981'}
                fillOpacity={isSelected ? 1 : 0.85}
                className={`transition-colors ${isHovered ? 'brightness-125' : ''}`}
              />

              {/* Data Labels above Bar: Completed Jobs + Clients */}
              {showLabels && item.count > 0 && (
                <text
                  x={x + barWidth / 2}
                  y={y - 6}
                  textAnchor="middle"
                  className="text-[9px] sm:text-[10px] font-mono select-none"
                >
                  <tspan className="fill-emerald-300 font-bold">{item.count}</tspan>
                  {item.clients > 0 && (
                    <tspan className="fill-violet-300 font-semibold"> ({item.clients}c)</tspan>
                  )}
                </text>
              )}

              {/* X-axis Label */}
              <text
                x={x + barWidth / 2}
                y={height - padding.bottom + 16}
                textAnchor="middle"
                className={`text-[9px] sm:text-[10px] font-medium transition-colors ${
                  isSelected ? 'fill-emerald-400 font-bold' : 'fill-zinc-400'
                }`}
              >
                {labelStr}
              </text>
            </g>
          );
        })}

        {/* Client Stat Overlay Line */}
        {clientLinePath && (
          <path
            d={clientLinePath}
            fill="none"
            stroke="#a855f7"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none opacity-90"
          />
        )}

        {/* Client Points on Overlay */}
        {clientPoints.map((pt, idx) => (
          <circle
            key={`cp-${idx}`}
            cx={pt.x}
            cy={pt.y}
            r={pt.clients > 0 ? 3 : 1.5}
            fill={pt.clients > 0 ? '#c084fc' : '#52525b'}
            stroke="#09090b"
            strokeWidth="1"
            className="pointer-events-none"
          />
        ))}

        {/* Hover Tooltip Card */}
        {hoveredBar && (
          <g transform={`translate(${hoveredBar.x}, ${Math.max(padding.top + 25, hoveredBar.y)})`}>
            <rect
              x="-65"
              y="-48"
              width="130"
              height="44"
              rx="6"
              fill="#09090b"
              stroke="#3f3f46"
              strokeWidth="1"
              className="drop-shadow-lg"
            />
            <text x="0" y="-33" textAnchor="middle" className="text-[10px] fill-zinc-300 font-medium">
              📅 {hoveredBar.day}
            </text>
            <text x="0" y="-19" textAnchor="middle" className="text-[11px] font-bold fill-emerald-400 font-mono">
              ✅ {hoveredBar.count} Completed
            </text>
            <text x="0" y="-7" textAnchor="middle" className="text-[10px] font-semibold fill-violet-300 font-mono">
              👥 {hoveredBar.clients} {hoveredBar.clients === 1 ? 'Client' : 'Clients'}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

// =========================================================================
// SUBCOMPONENT: HOURLY CURVE OVERLAY CHART (Fast 24-hr Spline & Client Line)
// =========================================================================
function HourlyCurveOverlayChart({ data, showLabels, hoveredHour, setHoveredHour, selectedTz }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(1000);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) setWidth(Math.max(650, entries[0].contentRect.width));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const height = 210;
  const padding = { top: 25, right: 35, bottom: 35, left: 45 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxJobs = Math.max(5, ...data.map(d => d.count || 0));
  const roundedMaxJobs = Math.ceil(maxJobs * 1.25);

  const maxClients = Math.max(1, ...data.map(d => d.clients || 0));
  const roundedMaxClients = Math.ceil(maxClients * 1.25);

  const getYJobs = (val) => chartH - (val / roundedMaxJobs) * chartH;
  const getYClients = (val) => chartH - (val / roundedMaxClients) * chartH;

  const totalDivisions = Math.max(1, data.length - 1);
  const jobPoints = data.map((d, i) => {
    const x = padding.left + (i / totalDivisions) * chartW;
    const y = padding.top + getYJobs(d.count || 0);
    return { ...d, x, y };
  });

  const clientPoints = data.map((d, i) => {
    const x = padding.left + (i / totalDivisions) * chartW;
    const y = padding.top + getYClients(d.clients || 0);
    return { ...d, x, y };
  });

  // Flowy bezier generator
  const createSmoothPath = (pts) => {
    if (pts.length === 0) return '';
    let path = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];

      const tension = 0.2;
      const cp1x = p1.x + (p2.x - p0.x) * tension;
      const cp1y = p1.y + (p2.y - p0.y) * tension;
      const cp2x = p2.x - (p3.x - p1.x) * tension;
      const cp2y = p2.y - (p3.y - p1.y) * tension;

      path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return path;
  };

  const jobLinePath = createSmoothPath(jobPoints);
  const clientLinePath = createSmoothPath(clientPoints);

  return (
    <div ref={containerRef} className="w-full overflow-x-auto select-none">
      <svg width={width} height={height} className="overflow-visible">
        {/* Horizontal Grid */}
        {[0, 0.5, 1].map((pct, i) => {
          const yJobVal = Math.round(roundedMaxJobs * pct);
          const yClientVal = Math.round(roundedMaxClients * pct);
          const yPos = padding.top + getYJobs(yJobVal);

          return (
            <g key={i}>
              <line
                x1={padding.left}
                y1={yPos}
                x2={width - padding.right}
                y2={yPos}
                stroke="#27272a"
                strokeDasharray={pct === 0 ? '0' : '3 3'}
              />
              <text
                x={padding.left - 6}
                y={yPos + 3}
                textAnchor="end"
                className="text-[10px] fill-zinc-500 font-mono"
              >
                {yJobVal}
              </text>
              <text
                x={width - padding.right + 6}
                y={yPos + 3}
                textAnchor="start"
                className="text-[10px] fill-violet-400/80 font-mono"
              >
                {yClientVal}c
              </text>
            </g>
          );
        })}

        {/* 24 Vertical Grid Lines */}
        {jobPoints.map((p, i) => (
          <line
            key={`grid-${i}`}
            x1={p.x}
            y1={padding.top}
            x2={p.x}
            y2={padding.top + chartH}
            stroke="#18181b"
            strokeDasharray="2 3"
          />
        ))}

        {/* Curve Line: Jobs (Cyan) */}
        {jobLinePath && (
          <path
            d={jobLinePath}
            fill="none"
            stroke="#22d3ee"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Curve Line: Clients (Violet) */}
        {clientLinePath && (
          <path
            d={clientLinePath}
            fill="none"
            stroke="#a855f7"
            strokeWidth="2"
            strokeDasharray="4 3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="opacity-80"
          />
        )}

        {/* Interactive Points along Curve */}
        {jobPoints.map((p, idx) => {
          const cp = clientPoints[idx];
          const isHovered = hoveredHour?.hour === p.hour;

          return (
            <g
              key={`hpt-${idx}`}
              className="cursor-pointer"
              onMouseEnter={() => {
                setHoveredHour({
                  hour: p.hour,
                  label: p.label,
                  displayRange: p.displayRange,
                  count: p.count,
                  clients: cp?.clients || 0,
                  x: p.x,
                  y: p.y
                });
              }}
              onMouseLeave={() => setHoveredHour(null)}
            >
              {/* Hit region */}
              <circle cx={p.x} cy={p.y} r={10} fill="transparent" />

              {/* Bold Point on Jobs Curve */}
              <circle
                cx={p.x}
                cy={p.y}
                r={isHovered ? 5.5 : (p.count > 0 ? 4 : 2.5)}
                fill={p.count > 0 ? '#22d3ee' : '#71717a'}
                stroke="#09090b"
                strokeWidth={1.5}
              />

              {/* Dot on Client Curve */}
              {cp && cp.clients > 0 && (
                <circle
                  cx={cp.x}
                  cy={cp.y}
                  r={2.5}
                  fill="#c084fc"
                  stroke="#09090b"
                  strokeWidth="1"
                />
              )}

              {/* Persistent Labels: Completed Jobs + Clients */}
              {showLabels && p.count > 0 && (
                <text
                  x={p.x}
                  y={p.y - 7}
                  textAnchor="middle"
                  className="text-[9px] sm:text-[10px] font-mono select-none"
                >
                  <tspan className="fill-cyan-300 font-bold">{p.count}</tspan>
                  {p.clients > 0 && (
                    <tspan className="fill-violet-300 font-semibold"> ({p.clients}c)</tspan>
                  )}
                </text>
              )}

              {/* 24-Hour X-axis text */}
              <text
                x={p.x}
                y={height - padding.bottom + 16}
                textAnchor="middle"
                className={`text-[9px] font-mono transition-colors ${
                  isHovered ? 'fill-cyan-300 font-bold' : (p.count > 0 ? 'fill-zinc-300' : 'fill-zinc-500')
                }`}
              >
                {p.label}
              </text>
            </g>
          );
        })}

        {/* Hover Tooltip Card */}
        {hoveredHour && (
          <g transform={`translate(${hoveredHour.x}, ${Math.max(padding.top + 25, hoveredHour.y - 12)})`}>
            <rect
              x="-80"
              y="-50"
              width="160"
              height="46"
              rx="6"
              fill="#09090b"
              stroke="#3f3f46"
              strokeWidth="1"
              className="drop-shadow-lg"
            />
            <text x="0" y="-35" textAnchor="middle" className="text-[10px] fill-zinc-300 font-medium">
              🕒 {hoveredHour.displayRange} ({selectedTz})
            </text>
            <text x="0" y="-21" textAnchor="middle" className="text-[11px] font-bold fill-cyan-400 font-mono">
              ✅ {hoveredHour.count} Completed Jobs
            </text>
            <text x="0" y="-8" textAnchor="middle" className="text-[10px] font-semibold fill-violet-300 font-mono">
              👥 {hoveredHour.clients} {hoveredHour.clients === 1 ? 'Client' : 'Clients'}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
