import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  X, 
  Calendar, 
  BarChart2, 
  Sparkles, 
  Globe, 
  Info
} from 'lucide-react';
import { format, parseISO, startOfMonth } from 'date-fns';

// Helper to zero-fill missing days in date range
function fillDateGaps(rows, startStr, endStr) {
  if (!startStr || !endStr) return rows || [];
  const countsMap = new Map();
  (rows || []).forEach(r => countsMap.set(r.day, r.count));

  const result = [];
  let curr = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');

  while (curr <= end) {
    const dayStr = curr.toISOString().slice(0, 10);
    result.push({
      day: dayStr,
      count: countsMap.get(dayStr) || 0
    });
    curr.setDate(curr.getDate() + 1);
  }
  return result;
}

// Timezone helper to format 'YYYY-MM-DD' in specified timezone
function getTodayInTz(tz) {
  const tzIanaMap = {
    IST: 'Asia/Kolkata',
    UTC: 'UTC',
    EST: 'America/New_York',
    CST: 'America/Chicago',
    PST: 'America/Los_Angeles'
  };
  const iana = tzIanaMap[tz] || 'Asia/Kolkata';
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
  // --- STATE ---
  const [showLabels, setShowLabels] = useState(true);

  const todayStr = useMemo(() => getTodayInTz(selectedTz), [selectedTz]);

  // First day of current month in selected timezone
  const monthStartStr = useMemo(() => {
    try {
      const d = parseISO(todayStr);
      return format(startOfMonth(d), 'yyyy-MM-dd');
    } catch {
      return todayStr.slice(0, 8) + '01';
    }
  }, [todayStr]);

  // Histogram Date Range
  const [fromDate, setFromDate] = useState(monthStartStr);
  const [toDate, setToDate] = useState(todayStr);

  // Hourly Target Date
  const [hourlyDate, setHourlyDate] = useState(todayStr);

  // Data States
  const [dailyData, setDailyData] = useState([]);
  const [loadingDaily, setLoadingDaily] = useState(false);
  const [dailyError, setDailyError] = useState('');

  const [hourlyData, setHourlyData] = useState([]);
  const [loadingHourly, setLoadingHourly] = useState(false);
  const [hourlyError, setHourlyError] = useState('');

  // Hover States for Tooltips
  const [hoveredBar, setHoveredBar] = useState(null); // { day, count, x, y }
  const [hoveredHour, setHoveredHour] = useState(null); // { hour, label, count, x, y }

  // Keyboard Escape listener
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Sync date defaults when timezone changes
  useEffect(() => {
    setFromDate(monthStartStr);
    setToDate(todayStr);
    setHourlyDate(todayStr);
  }, [selectedTz, monthStartStr, todayStr]);

  // --- FETCH DAILY HISTOGRAM DATA ---
  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;

    const fetchDaily = async () => {
      setLoadingDaily(true);
      setDailyError('');
      try {
        let url = `/api/analytics/daily?tz=${encodeURIComponent(selectedTz)}`;
        if (fromDate && toDate) {
          url += `&from=${fromDate} 00:00:00&to=${toDate} 23:59:59`;
        }
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!isCancelled) {
          // Fill continuous dates between fromDate and toDate
          const populated = fillDateGaps(data, fromDate, toDate);
          setDailyData(populated);
        }
      } catch (err) {
        if (!isCancelled) setDailyError(err.message || 'Failed to load daily analytics');
      } finally {
        if (!isCancelled) setLoadingDaily(false);
      }
    };

    fetchDaily();
    return () => { isCancelled = true; };
  }, [isOpen, fromDate, toDate, selectedTz]);

  // --- FETCH HOURLY CURVE DATA ---
  useEffect(() => {
    if (!isOpen || !hourlyDate) return;
    let isCancelled = false;

    const fetchHourly = async () => {
      setLoadingHourly(true);
      setHourlyError('');
      try {
        const url = `/api/analytics/hourly?date=${encodeURIComponent(hourlyDate)}&tz=${encodeURIComponent(selectedTz)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!isCancelled) {
          setHourlyData(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        if (!isCancelled) setHourlyError(err.message || 'Failed to load hourly analytics');
      } finally {
        if (!isCancelled) setLoadingHourly(false);
      }
    };

    fetchHourly();
    return () => { isCancelled = true; };
  }, [isOpen, hourlyDate, selectedTz]);

  // --- METRICS ---
  const totalDailyCompleted = useMemo(() => {
    return dailyData.reduce((acc, curr) => acc + (curr.count || 0), 0);
  }, [dailyData]);

  const dailyAvg = useMemo(() => {
    if (dailyData.length === 0) return 0;
    return (totalDailyCompleted / dailyData.length).toFixed(1);
  }, [totalDailyCompleted, dailyData]);

  const totalHourlyCompleted = useMemo(() => {
    return hourlyData.reduce((acc, curr) => acc + (curr.count || 0), 0);
  }, [hourlyData]);

  const peakHour = useMemo(() => {
    if (hourlyData.length === 0) return null;
    let maxObj = hourlyData[0];
    for (const h of hourlyData) {
      if (h.count > maxObj.count) maxObj = h;
    }
    return maxObj.count > 0 ? maxObj : null;
  }, [hourlyData]);

  // Quick range helpers
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
    <div className="fixed inset-0 z-50 bg-[#09090b]/98 backdrop-blur-2xl overflow-y-auto text-zinc-100 flex flex-col p-4 sm:p-8 animate-in fade-in duration-200">
      
      {/* --- TOP APPLE-STYLE NAV HEADER --- */}
      <div className="max-w-7xl w-full mx-auto flex items-center justify-between pb-6 border-b border-zinc-800/80 shrink-0">
        <div className="flex items-center gap-4">
          {/* Apple-style circular close button on top-left */}
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-zinc-800/90 hover:bg-zinc-700 active:scale-95 text-zinc-300 hover:text-white border border-zinc-700/80 flex items-center justify-center transition-all cursor-pointer shadow-md group"
            title="Close (Esc)"
          >
            <X className="w-4 h-4 transition-transform group-hover:scale-110" />
          </button>
          
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2.5">
                <span className="p-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                  <BarChart2 className="w-5 h-5" />
                </span>
                Automation Performance Analytics
              </h1>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Visual intelligence for completed job application flow
            </p>
          </div>
        </div>

        {/* Header Right Actions: Timezone Badge & Data Labels Switch */}
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-zinc-300">
            <Globe className="w-3.5 h-3.5 text-blue-400" />
            <span className="font-semibold text-zinc-200">Timezone:</span>
            <span className="font-mono text-emerald-400 font-bold">{selectedTz}</span>
          </div>

          {/* Persistent Label Toggle */}
          <button
            type="button"
            onClick={() => setShowLabels(!showLabels)}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl border text-xs font-semibold transition-all cursor-pointer shadow-sm ${
              showLabels
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40 shadow-emerald-950/40'
                : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:border-zinc-700 hover:text-zinc-200'
            }`}
            title="Toggle values permanently above each bar and point"
          >
            <span className={`w-2.5 h-2.5 rounded-full transition-all ${showLabels ? 'bg-emerald-400 ring-4 ring-emerald-500/20' : 'bg-zinc-600'}`} />
            <span>Data Labels: <strong className={showLabels ? 'text-emerald-300' : 'text-zinc-500'}>{showLabels ? 'ON' : 'OFF'}</strong></span>
          </button>
        </div>
      </div>

      {/* --- MAIN SCROLLABLE DASHBOARD BODY --- */}
      <div className="max-w-7xl w-full mx-auto flex-1 flex flex-col gap-8 py-8">
        
        {/* ============================================================== */}
        {/* 1. DAILY COMPLETED JOBS (HISTOGRAM)                            */}
        {/* ============================================================== */}
        <div className="bg-zinc-900/60 border border-zinc-800/90 rounded-2xl p-5 sm:p-7 shadow-xl backdrop-blur-xl relative flex flex-col gap-6">
          
          {/* Card Top Controls */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-zinc-800/60">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                  Daily Completed Jobs Histogram
                </h2>
              </div>
              <p className="text-xs text-zinc-400 mt-1 flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-zinc-500" />
                Click any bar below to instantly inspect its 24-hour distribution curve.
              </p>
            </div>

            {/* Date Range Controls & Quick Selectors */}
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-xl p-1 text-xs">
                <button
                  type="button"
                  onClick={() => handleQuickRange('month')}
                  className="px-2.5 py-1 rounded-lg hover:bg-zinc-800/80 font-medium text-zinc-300 transition-colors"
                >
                  This Month
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickRange('14d')}
                  className="px-2.5 py-1 rounded-lg hover:bg-zinc-800/80 font-medium text-zinc-300 transition-colors"
                >
                  Last 14D
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickRange('30d')}
                  className="px-2.5 py-1 rounded-lg hover:bg-zinc-800/80 font-medium text-zinc-300 transition-colors"
                >
                  Last 30D
                </button>
              </div>

              {/* Exact Date Inputs */}
              <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 rounded-xl px-2.5 py-1 text-xs">
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

              {/* Summary Badges */}
              <div className="flex items-center gap-2">
                <div className="px-3 py-1 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-semibold">
                  Total: <span className="text-white font-bold">{totalDailyCompleted.toLocaleString()}</span>
                </div>
                <div className="px-3 py-1 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-medium">
                  Avg: <span className="text-white font-bold">{dailyAvg}/day</span>
                </div>
              </div>
            </div>
          </div>

          {/* Histogram SVG Chart Component */}
          <div className="w-full relative min-h-[280px] flex items-center justify-center">
            {loadingDaily ? (
              <div className="flex items-center gap-2 text-zinc-400 text-sm py-16 animate-pulse">
                <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                Fetching daily statistics...
              </div>
            ) : dailyError ? (
              <div className="text-rose-400 text-xs py-12">{dailyError}</div>
            ) : dailyData.length === 0 ? (
              <div className="text-zinc-500 text-xs py-16">No completed job records found in this date range.</div>
            ) : (
              <HistogramChart 
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
        {/* 2. HOURLY DISTRIBUTION FLOW CURVE GRAPH                       */}
        {/* ============================================================== */}
        <div className="bg-zinc-900/60 border border-zinc-800/90 rounded-2xl p-5 sm:p-7 shadow-xl backdrop-blur-xl relative flex flex-col gap-6">
          
          {/* Card Top Controls */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-zinc-800/60">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
                <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                  Hourly Distribution Flow Curve
                </h2>
              </div>
              <p className="text-xs text-zinc-400 mt-1">
                Visualizing completed jobs in 1-hour time spans across all 24 hours of the day.
              </p>
            </div>

            {/* Hourly Target Date Controls */}
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-xl p-1 text-xs">
                <button
                  type="button"
                  onClick={() => handleQuickHourly('today')}
                  className={`px-3 py-1 rounded-lg font-medium transition-colors ${
                    hourlyDate === todayStr ? 'bg-zinc-800 text-emerald-400 font-bold' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickHourly('yesterday')}
                  className="px-3 py-1 rounded-lg hover:bg-zinc-800/80 font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Yesterday
                </button>
              </div>

              {/* Date Input */}
              <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-1 text-xs">
                <Calendar className="w-3.5 h-3.5 text-cyan-400" />
                <input
                  type="date"
                  value={hourlyDate}
                  onChange={(e) => setHourlyDate(e.target.value)}
                  className="bg-transparent text-zinc-200 outline-none text-xs font-medium cursor-pointer"
                />
              </div>

              {/* Peak Hour Indicator Badge */}
              <div className="flex items-center gap-2">
                {peakHour ? (
                  <div className="px-3 py-1 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                    Peak: <strong className="text-white">{peakHour.displayRange} ({peakHour.count} jobs)</strong>
                  </div>
                ) : (
                  <div className="px-3 py-1 rounded-xl bg-zinc-800/80 border border-zinc-700/60 text-zinc-400 text-xs">
                    No jobs completed on this date
                  </div>
                )}
                
                <div className="px-3 py-1 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-medium">
                  Day Total: <span className="text-white font-bold">{totalHourlyCompleted}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Hourly Curve SVG Component */}
          <div className="w-full relative min-h-[300px] flex items-center justify-center">
            {loadingHourly ? (
              <div className="flex items-center gap-2 text-zinc-400 text-sm py-16 animate-pulse">
                <div className="w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                Generating 24-hour flow curve...
              </div>
            ) : hourlyError ? (
              <div className="text-rose-400 text-xs py-12">{hourlyError}</div>
            ) : (
              <HourlyCurveChart
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
// SUBCOMPONENT: HISTOGRAM CHART (Custom SVG with Curved Bars & Tooltips)
// =========================================================================
function HistogramChart({ data, showLabels, selectedDate, onSelectDate, hoveredBar, setHoveredBar }) {
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

  const height = 260;
  const padding = { top: 35, right: 30, bottom: 45, left: 45 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxVal = Math.max(5, ...data.map(d => d.count || 0));
  const roundedMax = Math.ceil(maxVal * 1.15); // headroom for labels

  const barWidth = Math.max(14, Math.min(38, (chartW / data.length) * 0.65));

  const getY = (val) => chartH - (val / roundedMax) * chartH;
  const getX = (idx) => padding.left + (idx + 0.5) * (chartW / data.length);

  return (
    <div ref={containerRef} className="w-full overflow-x-auto select-none">
      <svg width={width} height={height} className="overflow-visible">
        <defs>
          <linearGradient id="emeraldBarGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#059669" stopOpacity="0.4" />
          </linearGradient>
          <linearGradient id="activeBarGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="1" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.8" />
          </linearGradient>
        </defs>

        {/* Horizontal Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => {
          const yVal = Math.round(roundedMax * pct);
          const yPos = padding.top + getY(yVal);
          return (
            <g key={i}>
              <line
                x1={padding.left}
                y1={yPos}
                x2={width - padding.right}
                y2={yPos}
                stroke="#27272a"
                strokeDasharray={pct === 0 ? '0' : '4 4'}
              />
              <text
                x={padding.left - 10}
                y={yPos + 4}
                textAnchor="end"
                className="text-[10px] fill-zinc-500 font-mono"
              >
                {yVal}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {data.map((item, idx) => {
          const x = getX(idx) - barWidth / 2;
          const barH = (item.count / roundedMax) * chartH;
          const y = padding.top + getY(item.count);
          const isSelected = item.day === selectedDate;
          const isHovered = hoveredBar?.day === item.day;

          // Format date for label
          let labelStr = item.day.slice(5); // '10-28'
          try {
            labelStr = format(parseISO(item.day), 'MMM d');
          } catch {}

          return (
            <g 
              key={item.day}
              className="cursor-pointer group"
              onClick={() => onSelectDate(item.day)}
              onMouseEnter={() => {
                setHoveredBar({
                  day: item.day,
                  count: item.count,
                  x: x + barWidth / 2,
                  y: y - 10
                });
              }}
              onMouseLeave={() => setHoveredBar(null)}
            >
              {/* Invisible wider hit area */}
              <rect
                x={x - 4}
                y={padding.top}
                width={barWidth + 8}
                height={chartH}
                fill="transparent"
              />

              {/* Background slot subtle bar */}
              <rect
                x={x}
                y={padding.top}
                width={barWidth}
                height={chartH}
                rx={6}
                ry={6}
                fill="#18181b"
                className="opacity-40"
              />

              {/* Actual curved bar */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(4, barH)}
                rx={6}
                ry={6}
                fill={isSelected ? 'url(#activeBarGrad)' : 'url(#emeraldBarGrad)'}
                className={`transition-all duration-150 ${
                  isSelected ? 'stroke-2 stroke-emerald-300 filter drop-shadow(0 0 8px rgba(16,185,129,0.5))' : ''
                } ${isHovered ? 'brightness-125' : ''}`}
              />

              {/* Exact Count Value above Bar when Toggle is ON */}
              {showLabels && item.count > 0 && (
                <text
                  x={x + barWidth / 2}
                  y={y - 7}
                  textAnchor="middle"
                  className={`text-[11px] font-bold font-mono transition-opacity ${
                    isSelected ? 'fill-emerald-300' : 'fill-zinc-300'
                  }`}
                >
                  {item.count}
                </text>
              )}

              {/* X-axis Day Label */}
              <text
                x={x + barWidth / 2}
                y={height - padding.bottom + 18}
                textAnchor="middle"
                className={`text-[10px] font-medium transition-colors ${
                  isSelected ? 'fill-emerald-400 font-bold' : 'fill-zinc-400'
                }`}
              >
                {labelStr}
              </text>

              {/* Bottom selection indicator dot */}
              {isSelected && (
                <circle
                  cx={x + barWidth / 2}
                  cy={height - padding.bottom + 26}
                  r={2.5}
                  fill="#10b981"
                />
              )}
            </g>
          );
        })}

        {/* Floating Tooltip Card */}
        {hoveredBar && (
          <g transform={`translate(${hoveredBar.x}, ${hoveredBar.y})`}>
            <rect
              x="-65"
              y="-42"
              width="130"
              height="38"
              rx="8"
              fill="#09090b"
              stroke="#27272a"
              strokeWidth="1.5"
              className="drop-shadow-2xl"
            />
            <text x="0" y="-24" textAnchor="middle" className="text-[11px] fill-zinc-300 font-medium">
              {hoveredBar.day}
            </text>
            <text x="0" y="-10" textAnchor="middle" className="text-[12px] font-bold fill-emerald-400 font-mono">
              {hoveredBar.count} Completed
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

// =========================================================================
// SUBCOMPONENT: HOURLY CURVE CHART (All 24 Hours, Flowy Spline, Bold Points)
// =========================================================================
function HourlyCurveChart({ data, showLabels, hoveredHour, setHoveredHour, selectedTz }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(1000);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) setWidth(Math.max(750, entries[0].contentRect.width));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const height = 280;
  const padding = { top: 40, right: 35, bottom: 55, left: 45 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxVal = Math.max(5, ...data.map(d => d.count || 0));
  const roundedMax = Math.ceil(maxVal * 1.25); // Headroom for bold numbers above points

  // Generate 25 points along X: hours 0, 1, 2, ..., 24
  // Hours 0..23 have data, 24 wraps or closes the day boundary
  const points = data.map((d, i) => {
    const x = padding.left + (i / 23) * chartW;
    const y = padding.top + chartH - ((d.count || 0) / roundedMax) * chartH;
    return { ...d, x, y };
  });

  // Build flowy smooth cubic bezier curve path through points
  const createSmoothPath = (pts) => {
    if (pts.length === 0) return '';
    let path = `M ${pts[0].x} ${pts[0].y}`;

    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];

      // Tension factor for flowy bezier
      const tension = 0.2;
      const cp1x = p1.x + (p2.x - p0.x) * tension;
      const cp1y = p1.y + (p2.y - p0.y) * tension;

      const cp2x = p2.x - (p3.x - p1.x) * tension;
      const cp2y = p2.y - (p3.y - p1.y) * tension;

      path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return path;
  };

  const curveLinePath = createSmoothPath(points);

  // Closed area path for luminous gradient fill underneath
  const areaPath = points.length > 0
    ? `${curveLinePath} L ${points[points.length - 1].x} ${padding.top + chartH} L ${points[0].x} ${padding.top + chartH} Z`
    : '';

  return (
    <div ref={containerRef} className="w-full overflow-x-auto select-none">
      <svg width={width} height={height} className="overflow-visible">
        <defs>
          <linearGradient id="curveAreaGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.45" />
            <stop offset="60%" stopColor="#06b6d4" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
          </linearGradient>
          <filter id="pointGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#22d3ee" floodOpacity="0.8" />
          </filter>
        </defs>

        {/* Horizontal Guidelines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => {
          const yVal = Math.round(roundedMax * pct);
          const yPos = padding.top + chartH - (yVal / roundedMax) * chartH;
          return (
            <g key={i}>
              <line
                x1={padding.left}
                y1={yPos}
                x2={width - padding.right}
                y2={yPos}
                stroke="#27272a"
                strokeDasharray={pct === 0 ? '0' : '4 4'}
              />
              <text
                x={padding.left - 10}
                y={yPos + 4}
                textAnchor="end"
                className="text-[10px] fill-zinc-500 font-mono"
              >
                {yVal}
              </text>
            </g>
          );
        })}

        {/* All 24 Vertical Grid Lines */}
        {points.map((p, i) => (
          <line
            key={`grid-${i}`}
            x1={p.x}
            y1={padding.top}
            x2={p.x}
            y2={padding.top + chartH}
            stroke="#1f1f23"
            strokeDasharray="2 4"
          />
        ))}

        {/* Luminous Gradient Area Fill Under Curve */}
        {areaPath && (
          <path d={areaPath} fill="url(#curveAreaGlow)" className="transition-all duration-300" />
        )}

        {/* Flowy Smooth Line Curve */}
        {curveLinePath && (
          <path
            d={curveLinePath}
            fill="none"
            stroke="#22d3ee"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="filter drop-shadow-[0_2px_8px_rgba(34,211,238,0.4)]"
          />
        )}

        {/* Points & Labels for Every Hour */}
        {points.map((p, idx) => {
          const isHovered = hoveredHour?.hour === p.hour;
          return (
            <g
              key={`pt-${idx}`}
              className="cursor-pointer group"
              onMouseEnter={() => {
                setHoveredHour({
                  hour: p.hour,
                  label: p.label,
                  displayRange: p.displayRange,
                  count: p.count,
                  x: p.x,
                  y: p.y
                });
              }}
              onMouseLeave={() => setHoveredHour(null)}
            >
              {/* Invisible wider hit region */}
              <circle cx={p.x} cy={p.y} r={12} fill="transparent" />

              {/* Bold Point along the Curve */}
              <circle
                cx={p.x}
                cy={p.y}
                r={isHovered ? 6.5 : (p.count > 0 ? 4.5 : 3)}
                fill={p.count > 0 ? '#22d3ee' : '#71717a'}
                stroke="#09090b"
                strokeWidth={isHovered ? 2.5 : 2}
                filter={p.count > 0 ? 'url(#pointGlow)' : undefined}
                className="transition-all duration-150"
              />

              {/* Persistent Exact Count displayed above Point when Toggle is ON */}
              {showLabels && p.count > 0 && (
                <text
                  x={p.x}
                  y={p.y - 10}
                  textAnchor="middle"
                  className="text-[11px] font-bold font-mono fill-cyan-300 drop-shadow-md"
                >
                  {p.count}
                </text>
              )}

              {/* ALL 24 HOURS EXPLICITLY WRITTEN BELOW ALONG X-AXIS */}
              <text
                x={p.x}
                y={height - padding.bottom + 18}
                textAnchor="middle"
                className={`text-[9px] sm:text-[10px] font-mono transition-colors ${
                  isHovered ? 'fill-cyan-300 font-bold' : (p.count > 0 ? 'fill-zinc-300 font-semibold' : 'fill-zinc-500')
                }`}
              >
                {p.label}
              </text>
            </g>
          );
        })}

        {/* 24:00 Final Endpoint Marker on X-axis */}
        <text
          x={padding.left + chartW + 12}
          y={height - padding.bottom + 18}
          textAnchor="middle"
          className="text-[9px] sm:text-[10px] font-mono fill-zinc-500"
        >
          24:00
        </text>

        {/* Floating Tooltip Card for Hourly Point */}
        {hoveredHour && (
          <g transform={`translate(${hoveredHour.x}, ${Math.max(padding.top + 20, hoveredHour.y - 12)})`}>
            <rect
              x="-75"
              y="-46"
              width="150"
              height="42"
              rx="8"
              fill="#09090b"
              stroke="#3f3f46"
              strokeWidth="1.5"
              className="drop-shadow-2xl"
            />
            <text x="0" y="-28" textAnchor="middle" className="text-[11px] fill-zinc-300 font-medium">
              🕒 {hoveredHour.displayRange} ({selectedTz})
            </text>
            <text x="0" y="-12" textAnchor="middle" className="text-[12px] font-bold fill-cyan-400 font-mono">
              ✅ {hoveredHour.count} Completed Jobs
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
