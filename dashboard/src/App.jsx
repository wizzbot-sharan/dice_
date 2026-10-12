import React, { useState, useEffect, useRef } from 'react';
import { 
  format, 
  parseISO, 
  startOfMonth, 
  endOfMonth, 
  startOfWeek, 
  endOfWeek, 
  eachDayOfInterval, 
  isSameMonth, 
  isSameDay, 
  addMonths, 
  subMonths, 
  subDays, 
  startOfYear, 
  endOfYear 
} from 'date-fns';
import {
  Activity,
  CheckCircle2,
  XCircle,
  Users,
  Calendar,
  X,
  Play,
  RefreshCw,
  AlertTriangle,
  ExternalLink,
  LogOut,
  Lock,
  Search,
  Menu,
  Zap,
  ShieldCheck,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  BarChart3,
  AlertOctagon,
  Terminal,
  Layers,
  Sparkles,
  ArrowRight
} from 'lucide-react';

function App() {
  // Authentication State
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return localStorage.getItem('applywizz_auth') === 'true';
  });
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // Date State (Defaults to Today)
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const [fromDate, setFromDate] = useState(todayStr);
  const [toDate, setToDate] = useState(todayStr);

  // Date Picker Modal Popover State
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [tempFromDate, setTempFromDate] = useState(todayStr);
  const [tempToDate, setTempToDate] = useState(todayStr);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectingEnd, setSelectingEnd] = useState(false);

  // Navigation & View State
  const [activeSection, setActiveSection] = useState('all-stats'); // 'all-stats' | 'errors' | 'logs'
  const [isMenuDrawerOpen, setIsMenuDrawerOpen] = useState(false);

  // Stats & Client Data
  const [stats, setStats] = useState({
    totals: {
      active_clients: 0,
      total_completed: 0,
      completed_zoho_skipped: 0,
      properly_completed: 0,
      total_failed: 0
    },
    clients: []
  });
  const [loadingStats, setLoadingStats] = useState(true);

  // Errors State
  const [errors, setErrors] = useState([]);
  const [loadingErrors, setLoadingErrors] = useState(false);

  // Live Logs State
  const [logs, setLogs] = useState([]);
  const [logFilter, setLogFilter] = useState('');
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);
  const logsEndRef = useRef(null);

  // Modal / Selected Client State
  const [selectedClient, setSelectedClient] = useState(null); // { applywizz_id, company_email }
  const [clientJobs, setClientJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [clientFilter, setClientFilter] = useState('all'); // 'all' | 'completed' | 'zoho_skipped' | 'clean' | 'failed'

  // Action Loading States
  const [isTriggering, setIsTriggering] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // --- AUTHENTICATION ---
  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    setIsLoggingIn(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUser, password: loginPass })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        localStorage.setItem('applywizz_auth', 'true');
        setIsAuthenticated(true);
      } else {
        setLoginError(data.error || 'Invalid credentials');
      }
    } catch (err) {
      setLoginError('Server unreachable. Please check network.');
    }
    setIsLoggingIn(false);
  };

  const handleLogout = () => {
    localStorage.removeItem('applywizz_auth');
    setIsAuthenticated(false);
  };

  // --- DATA FETCHING ---
  const fetchStats = async () => {
    setLoadingStats(true);
    let url = '/api/stats?';
    if (fromDate && toDate) {
      url += `from=${fromDate}&to=${toDate} 23:59:59`;
    }
    try {
      const res = await fetch(url);
      const data = await res.json();
      setStats({
        totals: data.totals || {
          active_clients: 0,
          total_completed: 0,
          completed_zoho_skipped: 0,
          properly_completed: 0,
          total_failed: 0
        },
        clients: Array.isArray(data.clients) ? data.clients : []
      });
    } catch (e) {
      console.error('Error fetching stats:', e);
    }
    setLoadingStats(false);
  };

  const fetchErrors = async () => {
    setLoadingErrors(true);
    let url = '/api/errors?';
    if (fromDate && toDate) {
      url += `from=${fromDate}&to=${toDate} 23:59:59`;
    }
    try {
      const res = await fetch(url);
      const data = await res.json();
      setErrors(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Error fetching errors:', e);
    }
    setLoadingErrors(false);
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      const data = await res.json();
      setLogs(Array.isArray(data) ? data : []);
    } catch (e) { }
  };

  const formatFriendly = (isoStr) => {
    if (!isoStr) return '';
    try {
      return format(parseISO(isoStr), 'MMM. do yyyy');
    } catch {
      return isoStr;
    }
  };

  const openDatePicker = () => {
    setTempFromDate(fromDate);
    setTempToDate(toDate);
    try {
      setCalendarMonth(parseISO(fromDate));
    } catch {
      setCalendarMonth(new Date());
    }
    setSelectingEnd(false);
    setIsDatePickerOpen(true);
  };

  const handleApplyDates = () => {
    setFromDate(tempFromDate);
    setToDate(tempToDate);
    setIsDatePickerOpen(false);
  };

  const openClientModal = async (client) => {
    setSelectedClient(client);
    setClientJobs([]);
    setClientFilter('all');
    setLoadingJobs(true);
    let url = `/api/jobs/${encodeURIComponent(client.applywizz_id)}?`;
    if (fromDate && toDate) {
      url += `from=${fromDate}&to=${toDate} 23:59:59`;
    }
    try {
      const res = await fetch(url);
      const data = await res.json();
      setClientJobs(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Error loading client jobs:', e);
    }
    setLoadingJobs(false);
  };

  // --- ACTIONS ---
  const syncClients = async () => {
    if (!window.confirm("Sync all active clients from the API?")) return;
    setIsSyncing(true);
    try {
      const res = await fetch('/api/sync-clients', { method: 'POST' });
      if (res.ok) {
        alert('Client Sync initiated! Watch the Live Logs for progress.');
        fetchStats();
      } else {
        alert('Failed to initiate client sync.');
      }
    } catch (e) {
      alert('Network error during client sync.');
    }
    setIsSyncing(false);
  };

  const purgeQueue = async () => {
    if (!window.confirm("PURGE QUEUE: Instantly clear all active and pending jobs from memory?")) return;
    try {
      const res = await fetch('/api/purge-queue', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) alert(`Error: ${data.error}`);
      else {
        alert(`Success: ${data.message} (${data.cleared} items cleared)`);
        fetchStats();
      }
    } catch (err) {
      alert('Network error while purging queue.');
    }
  };

  const triggerAutomation = async () => {
    const action = window.prompt(
      "Choose automation run mode:\nType 'fresh' to reset 10-job limits to 0\nType 'resume' to continue existing run",
      "fresh"
    );
    if (!action || (action !== 'fresh' && action !== 'resume')) return;

    setIsTriggering(true);
    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: action })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Error: ${data.error}`);
      } else {
        alert(`Automation started (${action.toUpperCase()})! Check Live Logs.`);
        fetchStats();
      }
    } catch (e) {
      alert('Failed to trigger automation.');
    }
    setIsTriggering(false);
  };

  // Auto-scroll logs
  useEffect(() => {
    if (autoScrollLogs && logsEndRef.current && activeSection === 'logs') {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScrollLogs, activeSection]);

  // Reactive data fetching
  useEffect(() => {
    if (isAuthenticated) {
      fetchStats();
      fetchErrors();
      fetchLogs();
      const interval = setInterval(fetchLogs, 4000);
      return () => clearInterval(interval);
    }
  }, [isAuthenticated, fromDate, toDate]);

  // Derived Client Modal Stats
  const clientCompleted = clientJobs.filter(j => j.status === 'Completed').length;
  const clientZohoSkipped = clientJobs.filter(j =>
    j.status === 'Completed' && (j.reason?.toLowerCase().includes('zoho') || (j.reason && j.reason.trim() !== ''))
  ).length;
  const clientCleanCompleted = clientJobs.filter(j =>
    j.status === 'Completed' && (!j.reason || j.reason.trim() === '')
  ).length;
  const clientFailed = clientJobs.filter(j => j.status === 'Failed').length;

  const filteredClientJobs = clientJobs.filter(j => {
    if (clientFilter === 'completed') return j.status === 'Completed';
    if (clientFilter === 'zoho_skipped') {
      return j.status === 'Completed' && (j.reason?.toLowerCase().includes('zoho') || (j.reason && j.reason.trim() !== ''));
    }
    if (clientFilter === 'clean') {
      return j.status === 'Completed' && (!j.reason || j.reason.trim() === '');
    }
    if (clientFilter === 'failed') return j.status === 'Failed';
    return true;
  });

  // Filtered live logs
  const filteredLogs = logs.filter(l => {
    if (!logFilter) return true;
    const q = logFilter.toLowerCase();
    return (l.applywizz_id && l.applywizz_id.toLowerCase().includes(q)) ||
      (l.message && l.message.toLowerCase().includes(q));
  });

  // Render anchored Navigation Menu Dropdown
  const renderNavMenu = (iconColorClass = "text-blue-400") => (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setIsMenuDrawerOpen(!isMenuDrawerOpen)}
        className="p-2 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-850 text-zinc-200 border border-zinc-700 hover:border-zinc-500 rounded-xl flex items-center gap-1.5 text-xs font-semibold shadow-sm transition-all cursor-pointer"
        title="Open Navigation Menu"
      >
        <Menu className={`w-4 h-4 ${iconColorClass}`} />
        <span>Menu</span>
        <ChevronDown className="w-3 h-3 text-zinc-400" />
      </button>

      {isMenuDrawerOpen && (
        <>
          {/* Invisible backdrop to dismiss on click outside */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsMenuDrawerOpen(false)}
          />

          {/* Anchored Dropdown Popover */}
          <div className="absolute top-full left-0 mt-2 z-50 w-64 bg-[#000000] border border-zinc-800 rounded-2xl p-2.5 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-100">
            <div className="flex items-center justify-between px-2.5 py-1.5 mb-1.5 border-b border-zinc-800">
              <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Navigation</span>
              <button
                type="button"
                onClick={() => setIsMenuDrawerOpen(false)}
                className="p-1 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <nav className="space-y-1">
              {/* Option 1: All Stats */}
              <button
                type="button"
                onClick={() => { setActiveSection('all-stats'); setIsMenuDrawerOpen(false); }}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${activeSection === 'all-stats'
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                  : 'text-zinc-300 hover:text-white hover:bg-zinc-800/80'
                  }`}
              >
                <div className="flex items-center gap-2.5">
                  <BarChart3 className="w-4 h-4" />
                  <span className="font-semibold">All Stats</span>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${activeSection === 'all-stats' ? 'bg-blue-500/50 text-white' : 'bg-zinc-800 text-zinc-400'
                  }`}>
                  {stats.clients.length}
                </span>
              </button>

              {/* Option 2: Errors */}
              <button
                type="button"
                onClick={() => { setActiveSection('errors'); setIsMenuDrawerOpen(false); }}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${activeSection === 'errors'
                  ? 'bg-rose-600 text-white shadow-md shadow-rose-600/30'
                  : 'text-zinc-300 hover:text-white hover:bg-zinc-800/80'
                  }`}
              >
                <div className="flex items-center gap-2.5">
                  <AlertOctagon className="w-4 h-4" />
                  <span className="font-semibold">Errors</span>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${activeSection === 'errors' ? 'bg-rose-500/50 text-white' : 'bg-rose-500/20 text-rose-400'
                  }`}>
                  {stats.totals.total_failed || 0}
                </span>
              </button>

              {/* Option 3: Live Logs */}
              <button
                type="button"
                onClick={() => { setActiveSection('logs'); setIsMenuDrawerOpen(false); }}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${activeSection === 'logs'
                  ? 'bg-zinc-800 text-white border border-zinc-700'
                  : 'text-zinc-300 hover:text-white hover:bg-zinc-800/80'
                  }`}
              >
                <div className="flex items-center gap-2.5">
                  <Terminal className="w-4 h-4" />
                  <span className="font-semibold">Live Logs</span>
                </div>
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
              </button>
            </nav>
          </div>
        </>
      )}
    </div>
  );

  // --- RENDER LOGIN VIEW ---
  if (!isAuthenticated) {
    return (
      <div className="relative min-h-screen bg-zinc-950 flex items-center justify-center p-6 text-zinc-100 font-sans selection:bg-blue-600 selection:text-white overflow-hidden">

        {/* Responsive Background Images with gentle blur and high clarity */}
        <div className="absolute inset-0 pointer-events-none select-none overflow-hidden">
          {/* Desktop background for PC / medium-large displays */}
          <img
            src="/Logo_desktop.png"
            alt="Background"
            className="hidden md:block w-full h-full object-cover object-center filter blur-[2px] scale-105 opacity-85 transition-all"
          />
          {/* Mobile background for mobile devices */}
          <img
            src="/Logo_mobile.png"
            alt="Background"
            className="block md:hidden w-full h-full object-cover object-center filter blur-[2px] scale-105 opacity-85 transition-all"
          />
          {/* Subtle translucent dark tint for contrast */}
          <div className="absolute inset-0 bg-black/25" />
        </div>

        {/* Highly Translucent Frosted Glass Login Card */}
        <div className="relative z-10 w-full max-w-md">
          <div className="bg-black/30 backdrop-blur-md border border-white/15 rounded-3xl p-8 shadow-2xl shadow-black/50">

            {/* Header: Just 'Dice Login', no logo */}
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold tracking-tight text-white drop-shadow-md">Dice Login</h1>
            </div>

            {loginError && (
              <div className="mb-6 p-3 bg-red-500/20 border border-red-500/30 rounded-xl flex items-center gap-2 text-red-300 text-xs backdrop-blur-sm">
                <AlertOctagon className="w-4 h-4 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-200 mb-1.5 drop-shadow-sm">Username</label>
                <input
                  type="text"
                  required
                  value={loginUser}
                  onChange={(e) => setLoginUser(e.target.value)}
                  placeholder="admin"
                  className="w-full px-3.5 py-2.5 bg-black/25 backdrop-blur-sm border border-white/15 rounded-xl text-sm text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-200 mb-1.5 drop-shadow-sm">Password</label>
                <input
                  type="password"
                  required
                  value={loginPass}
                  onChange={(e) => setLoginPass(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full px-3.5 py-2.5 bg-black/25 backdrop-blur-sm border border-white/15 rounded-xl text-sm text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 transition-all"
                />
              </div>

              <button
                type="submit"
                disabled={isLoggingIn}
                className="w-full mt-2 py-2.5 bg-blue-600/90 hover:bg-blue-500 active:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-lg shadow-blue-600/35 transition-all flex items-center justify-center disabled:opacity-50"
              >
                {isLoggingIn ? 'Authenticating...' : 'Sign In'}
              </button>
            </form>

            <div className="mt-8 text-center border-t border-white/10 pt-4">
              <p className="text-[11px] text-zinc-300 drop-shadow-sm">Authorized personnel only &bull; Enterprise Session</p>
            </div>
          </div>
        </div>

      </div>
    );
  }

  // --- RENDER AUTHENTICATED DASHBOARD ---
  return (
    <div className="min-h-screen bg-[#111111] text-zinc-100 font-sans selection:bg-blue-600 selection:text-white flex flex-col">

      {/* 1. APPLE-STYLE TOP NAV BAR */}
      <header className="sticky top-0 z-40 bg-[#000000] border-b border-zinc-900/80 px-4 lg:px-8 py-2.5 transition-all shadow-md">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">

          {/* Left: Brand Logo Only */}
          <div className="flex items-center">
            <img
              src="/apply_wizz_logo.jpeg"
              alt="ApplyWizz"
              className="h-9 w-auto rounded-xl object-contain border border-zinc-800 shadow-sm"
            />
          </div>

          {/* Middle: Centered Action Controls & Date Picker (Apple-Style) */}
          <div className="flex items-center gap-3 overflow-x-auto py-1">

            {/* Run Automation */}
            <button
              onClick={triggerAutomation}
              disabled={isTriggering}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all shadow-sm shadow-blue-600/30 disabled:opacity-50"
              title="Start Automation Run"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>{isTriggering ? 'Starting...' : 'Run Automation'}</span>
            </button>

            {/* Sync Clients */}
            <button
              onClick={syncClients}
              disabled={isSyncing}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-800 text-zinc-200 border border-zinc-700 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all disabled:opacity-50"
              title="Sync Clients from CRM"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-green-400' : 'text-zinc-400'}`} />
              <span>{isSyncing ? 'Syncing...' : 'Sync Clients'}</span>
            </button>

            {/* Purge Queue */}
            <button
              onClick={purgeQueue}
              className="px-3 py-1.5 bg-red-950/40 hover:bg-red-900/50 text-red-400 border border-red-800/60 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all"
              title="Purge RAM Queue"
            >
              <X className="w-3.5 h-3.5" />
              <span>Purge Queue</span>
            </button>

            {/* Date Range Modal Popover Trigger */}
            <div className="relative">
              <button
                type="button"
                onClick={openDatePicker}
                className="flex items-center gap-2 bg-zinc-950 hover:bg-zinc-900 active:bg-zinc-850 border border-blue-500/40 hover:border-blue-500/80 rounded-xl px-3 py-1.5 text-xs text-zinc-100 transition-all shadow-sm group"
                title="Filter by Date Range"
              >
                <span className="font-medium text-zinc-200">
                  {formatFriendly(fromDate)}
                </span>
                <ArrowRight className="w-3 h-3 text-zinc-400 group-hover:text-blue-400 transition-colors" />
                <span className="font-medium text-zinc-200">
                  {formatFriendly(toDate)}
                </span>
                <Calendar className="w-3.5 h-3.5 text-blue-400 ml-0.5" />
              </button>

              {isDatePickerOpen && (() => {
                // Calendar calculations
                const todayObj = new Date();
                const monthStart = startOfMonth(calendarMonth);
                const monthEnd = endOfMonth(calendarMonth);
                const calendarStart = startOfWeek(monthStart, { weekStartsOn: 1 });
                const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
                const calendarDays = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

                // Dynamic suggestions matching screenshot
                const suggestions = [
                  {
                    id: 'today',
                    title: 'Today',
                    from: format(todayObj, 'yyyy-MM-dd'),
                    to: format(todayObj, 'yyyy-MM-dd'),
                    dateText: format(todayObj, 'd MMM yy')
                  },
                  {
                    id: 'this-week',
                    title: 'This week',
                    from: format(startOfWeek(todayObj, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
                    to: format(endOfWeek(todayObj, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
                    dateText: `${format(startOfWeek(todayObj, { weekStartsOn: 1 }), 'd MMM yy')} - ${format(endOfWeek(todayObj, { weekStartsOn: 1 }), 'd MMM yy')}`
                  },
                  {
                    id: 'last-7-days',
                    title: 'Last 7 days',
                    from: format(subDays(todayObj, 6), 'yyyy-MM-dd'),
                    to: format(todayObj, 'yyyy-MM-dd'),
                    dateText: `${format(subDays(todayObj, 6), 'd MMM yy')} - ${format(todayObj, 'd MMM yy')}`
                  },
                  {
                    id: 'this-month',
                    title: 'This month',
                    from: format(startOfMonth(todayObj), 'yyyy-MM-dd'),
                    to: format(endOfMonth(todayObj), 'yyyy-MM-dd'),
                    dateText: `${format(startOfMonth(todayObj), 'd MMM yy')} - ${format(endOfMonth(todayObj), 'd MMM yy')}`
                  },
                  {
                    id: 'last-31-days',
                    title: 'Last 31 days',
                    from: format(subDays(todayObj, 30), 'yyyy-MM-dd'),
                    to: format(todayObj, 'yyyy-MM-dd'),
                    dateText: `${format(subDays(todayObj, 30), 'd MMM yy')} - ${format(todayObj, 'd MMM yy')}`
                  },
                  {
                    id: 'this-year',
                    title: 'This year',
                    from: format(startOfYear(todayObj), 'yyyy-MM-dd'),
                    to: format(endOfYear(todayObj), 'yyyy-MM-dd'),
                    dateText: `${format(startOfYear(todayObj), 'd MMM yy')} - ${format(endOfYear(todayObj), 'd MMM yy')}`
                  }
                ];

                const handleDayClick = (day) => {
                  const dStr = format(day, 'yyyy-MM-dd');
                  if (!selectingEnd) {
                    setTempFromDate(dStr);
                    setTempToDate(dStr);
                    setSelectingEnd(true);
                  } else {
                    if (dStr < tempFromDate) {
                      setTempToDate(tempFromDate);
                      setTempFromDate(dStr);
                    } else {
                      setTempToDate(dStr);
                    }
                    setSelectingEnd(false);
                  }
                };

                const selectSuggestion = (s) => {
                  setTempFromDate(s.from);
                  setTempToDate(s.to);
                  setSelectingEnd(false);
                  try {
                    setCalendarMonth(parseISO(s.from));
                  } catch {}
                };

                return (
                  <>
                    {/* Backdrop */}
                    <div
                      className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]"
                      onClick={() => setIsDatePickerOpen(false)}
                    />

                    {/* Popover Card matching screenshot model */}
                    <div className="absolute top-full mt-2 right-0 z-50 w-[590px] max-w-[95vw] bg-[#000000] border border-zinc-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-100">
                      
                      {/* Top Body (Split: Left Calendar & Inputs, Right Suggestions) */}
                      <div className="flex flex-col sm:flex-row">
                        
                        {/* LEFT PANE: Inputs & Calendar */}
                        <div className="p-4 sm:w-[340px] flex flex-col">
                          
                          {/* From & To Preview Inputs */}
                          <div className="grid grid-cols-2 gap-2.5 mb-4">
                            <div>
                              <span className="block text-[11px] font-medium text-zinc-400 mb-1">From</span>
                              <div className="flex items-center justify-between px-2.5 py-1.5 bg-zinc-900 border border-zinc-700/80 rounded-xl text-xs text-zinc-100 shadow-sm">
                                <span className="truncate">{formatFriendly(tempFromDate) || '-'}</span>
                                <Calendar className="w-3.5 h-3.5 text-blue-400 shrink-0 ml-1" />
                              </div>
                            </div>
                            <div>
                              <span className="block text-[11px] font-medium text-zinc-400 mb-1">To</span>
                              <div className="flex items-center justify-between px-2.5 py-1.5 bg-zinc-900 border border-zinc-700/80 rounded-xl text-xs text-zinc-100 shadow-sm">
                                <span className="truncate">{formatFriendly(tempToDate) || '-'}</span>
                                <Calendar className="w-3.5 h-3.5 text-blue-400 shrink-0 ml-1" />
                              </div>
                            </div>
                          </div>

                          {/* Month Navigation */}
                          <div className="flex items-center justify-between mb-3 px-1">
                            <h3 className="text-sm font-bold text-white tracking-tight">
                              {format(calendarMonth, 'MMMM yyyy')}
                            </h3>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setCalendarMonth(prev => subMonths(prev, 1))}
                                className="p-1.5 hover:bg-zinc-800 active:bg-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-100 border border-zinc-800 transition-colors"
                                title="Previous Month"
                              >
                                <ChevronLeft className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setCalendarMonth(prev => addMonths(prev, 1))}
                                className="p-1.5 hover:bg-zinc-800 active:bg-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-100 border border-zinc-800 transition-colors"
                                title="Next Month"
                              >
                                <ChevronRight className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Day of Week Headers */}
                          <div className="grid grid-cols-7 gap-1 text-center mb-1">
                            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(name => (
                              <div key={name} className="text-[11px] font-semibold text-zinc-400 py-1">
                                {name}
                              </div>
                            ))}
                          </div>

                          {/* Interactive Calendar Grid with continuous Range Ribbon */}
                          <div className="grid grid-cols-7 gap-y-1">
                            {calendarDays.map((day) => {
                              const dStr = format(day, 'yyyy-MM-dd');
                              const inCurrentMonth = isSameMonth(day, calendarMonth);
                              const isToday = isSameDay(day, todayObj);
                              const isStart = tempFromDate && dStr === tempFromDate;
                              const isEnd = tempToDate && dStr === tempToDate;
                              const hasRange = tempFromDate && tempToDate && tempFromDate < tempToDate;
                              const isBetween = hasRange && dStr > tempFromDate && dStr < tempToDate;

                              return (
                                <div
                                  key={dStr}
                                  onClick={() => handleDayClick(day)}
                                  className="h-8 w-full flex items-center justify-center relative cursor-pointer group"
                                >
                                  {/* Range Highlight Ribbon */}
                                  {isBetween && (
                                    <div className="absolute inset-y-0.5 inset-x-0 bg-blue-600/20" />
                                  )}
                                  {isStart && hasRange && (
                                    <div className="absolute inset-y-0.5 left-1/2 right-0 bg-blue-600/20" />
                                  )}
                                  {isEnd && hasRange && (
                                    <div className="absolute inset-y-0.5 left-0 right-1/2 bg-blue-600/20" />
                                  )}

                                  {/* Day Circle / Text */}
                                  <div className={`relative z-10 w-7 h-7 rounded-full flex flex-col items-center justify-center text-xs transition-all ${
                                    isStart || isEnd
                                      ? 'bg-blue-600 text-white font-bold shadow-md shadow-blue-600/40'
                                      : isBetween
                                      ? 'text-blue-200 font-medium'
                                      : inCurrentMonth
                                      ? 'text-zinc-200 group-hover:bg-zinc-800'
                                      : 'text-zinc-600 group-hover:bg-zinc-900'
                                  }`}>
                                    <span>{format(day, 'd')}</span>
                                    {isToday && !isStart && !isEnd && (
                                      <div className="w-1 h-1 rounded-full bg-rose-500 absolute bottom-0.5" />
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                        </div>

                        {/* RIGHT PANE: Suggestions matching screenshot */}
                        <div className="p-4 sm:w-[250px] border-t sm:border-t-0 sm:border-l border-zinc-800 flex flex-col justify-between">
                          <div>
                            <h4 className="text-xs font-bold text-blue-400 tracking-wide mb-3">Suggestions</h4>
                            <div className="space-y-1.5">
                              {suggestions.map((s) => {
                                const active = tempFromDate === s.from && tempToDate === s.to;
                                return (
                                  <button
                                    key={s.id}
                                    type="button"
                                    onClick={() => selectSuggestion(s)}
                                    className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-left text-xs transition-all ${
                                      active
                                        ? 'bg-blue-600/20 border border-blue-500/40 text-blue-200 shadow-sm'
                                        : 'text-zinc-300 hover:text-white hover:bg-zinc-900 border border-transparent'
                                    }`}
                                  >
                                    <span className="font-semibold text-zinc-200">{s.title}</span>
                                    <span className={`text-[10px] font-mono shrink-0 ml-2 ${active ? 'text-blue-300' : 'text-zinc-500'}`}>
                                      {s.dateText}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>

                      </div>

                      {/* FOOTER BAR: Cancel & Apply */}
                      <div className="border-t border-zinc-800 px-4 py-3 flex items-center justify-between bg-zinc-950/60">
                        <button
                          type="button"
                          onClick={() => setIsDatePickerOpen(false)}
                          className="text-xs font-medium text-zinc-400 hover:text-zinc-100 underline-offset-4 hover:underline transition-colors px-1"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleApplyDates}
                          className="px-6 py-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-semibold rounded-xl text-xs shadow-lg shadow-blue-600/35 transition-all"
                        >
                          Apply
                        </button>
                      </div>

                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Right: Logout Button */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleLogout}
              className="px-2.5 py-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors border border-transparent hover:border-zinc-700"
              title="Sign Out"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>

        </div>
      </header>

      <div className="max-w-7xl w-full mx-auto p-4 lg:p-6 space-y-6 flex-1 flex flex-col">

        {/* 2. STATS OVERVIEW BAR UNDER TOP NAV (5 METRIC CARDS) */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 lg:gap-4">

          {/* Card 1: Active Clients */}
          <div className="bg-[#000000] border border-zinc-800 rounded-2xl p-4 flex items-center justify-between shadow-xl relative overflow-hidden group hover:border-blue-500/40 transition-all">
            <div>
              <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Active Clients</p>
              <h3 className="text-2xl font-bold tracking-tight text-white mt-1">
                {stats.totals.active_clients || 0}
              </h3>
              <p className="text-[10px] text-zinc-500 mt-0.5">from CRM info</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
              <Users className="w-5 h-5" />
            </div>
          </div>

          {/* Card 2: Total Completed Jobs */}
          <div className="bg-[#000000] border border-zinc-800 rounded-2xl p-4 flex items-center justify-between shadow-xl relative overflow-hidden group hover:border-indigo-500/40 transition-all">
            <div>
              <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Completed Jobs</p>
              <h3 className="text-2xl font-bold tracking-tight text-white mt-1">
                {stats.totals.total_completed || 0}
              </h3>
              <p className="text-[10px] text-zinc-500 mt-0.5">in selected date</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center shrink-0">
              <Layers className="w-5 h-5" />
            </div>
          </div>

          {/* Card 3: Completed with Zoho Skipped / Failed */}
          <div className="bg-[#000000] border border-zinc-800 rounded-2xl p-4 flex items-center justify-between shadow-xl relative overflow-hidden group hover:border-amber-500/40 transition-all">
            <div>
              <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Zoho Skipped</p>
              <h3 className="text-2xl font-bold tracking-tight text-amber-400 mt-1">
                {stats.totals.completed_zoho_skipped || 0}
              </h3>
              <p className="text-[10px] text-zinc-500 mt-0.5">completed &bull; no proof</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
          </div>

          {/* Card 4: Properly Completed (Clean / Nothing in reason) */}
          <div className="bg-[#000000] border border-zinc-800 rounded-2xl p-4 flex items-center justify-between shadow-xl relative overflow-hidden group hover:border-emerald-500/40 transition-all">
            <div>
              <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Clean Completed</p>
              <h3 className="text-2xl font-bold tracking-tight text-emerald-400 mt-1">
                {stats.totals.properly_completed || 0}
              </h3>
              <p className="text-[10px] text-zinc-500 mt-0.5">verified Zoho receipt</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
          </div>

          {/* Card 5: Failed Jobs */}
          <div className="col-span-2 md:col-span-1 bg-[#000000] border border-zinc-800 rounded-2xl p-4 flex items-center justify-between shadow-xl relative overflow-hidden group hover:border-rose-500/40 transition-all">
            <div>
              <p className="text-[11px] font-medium text-zinc-400 uppercase tracking-wider">Failed Jobs</p>
              <h3 className="text-2xl font-bold tracking-tight text-rose-400 mt-1">
                {stats.totals.total_failed || 0}
              </h3>
              <p className="text-[10px] text-zinc-500 mt-0.5">errors logged</p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 flex items-center justify-center shrink-0">
              <XCircle className="w-5 h-5" />
            </div>
          </div>

        </div>

        {/* 4. MAIN WORKSPACE (FULL WIDTH) */}
        <main className="w-full flex-1">

          {/* SECTION 1: ALL STATS (DEFAULT VIEW - CLIENT LIST) */}
          {activeSection === 'all-stats' && (
            <div className="bg-[#000000] border border-zinc-800 rounded-2xl shadow-xl overflow-hidden flex flex-col">
              <div className="px-6 py-4 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#000000]">
                <div className="flex items-center gap-3">
                  {renderNavMenu("text-blue-400")}
                  <div>
                    <h2 className="text-base font-semibold text-white tracking-tight">Client Performance Overview</h2>
                    <p className="text-xs text-zinc-400">Date window: {fromDate} to {toDate}</p>
                  </div>
                </div>
                <div className="text-xs text-zinc-400">
                  Showing <span className="text-zinc-200 font-semibold">{stats.clients.length}</span> clients
                </div>
              </div>

              <div className="overflow-x-auto min-h-[450px]">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#000000] text-zinc-400 uppercase tracking-wider font-semibold border-b border-zinc-800">
                    <tr>
                      <th className="px-6 py-3.5">ApplyWizz ID</th>
                      <th className="px-6 py-3.5">Company Email</th>
                      <th className="px-6 py-3.5 text-center">Completed</th>
                      <th className="px-6 py-3.5 text-center">Failed</th>
                      <th className="px-6 py-3.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {loadingStats ? (
                      <tr>
                        <td colSpan="5" className="px-6 py-12 text-center text-zinc-500">
                          <div className="inline-flex items-center gap-2">
                            <RefreshCw className="w-4 h-4 animate-spin text-blue-500" />
                            <span>Loading client records...</span>
                          </div>
                        </td>
                      </tr>
                    ) : stats.clients.length === 0 ? (
                      <tr>
                        <td colSpan="5" className="px-6 py-12 text-center text-zinc-500">
                          No client job activity recorded for this date range.
                        </td>
                      </tr>
                    ) : (
                      stats.clients.map((client, idx) => (
                        <tr key={idx} className="hover:bg-zinc-800/30 transition-colors">
                          <td className="px-6 py-3.5 font-medium text-zinc-100 font-mono">
                            {client.applywizz_id}
                          </td>
                          <td className="px-6 py-3.5 text-zinc-400">
                            {client.company_email || <span className="text-zinc-600 italic">Not set</span>}
                          </td>
                          <td className="px-6 py-3.5 text-center">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${(client.completed_count || 0) > 0
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : 'bg-zinc-800/60 text-zinc-500'
                              }`}>
                              {client.completed_count || 0}
                            </span>
                          </td>
                          <td className="px-6 py-3.5 text-center">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${(client.failed_count || 0) > 0
                              ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                              : 'bg-zinc-800/60 text-zinc-500'
                              }`}>
                              {client.failed_count || 0}
                            </span>
                          </td>
                          <td className="px-6 py-3.5 text-right">
                            <button
                              onClick={() => openClientModal(client)}
                              className="inline-flex items-center gap-1 px-3 py-1 bg-zinc-800 hover:bg-blue-600 hover:text-white text-zinc-300 rounded-lg text-xs font-medium transition-all border border-zinc-700 hover:border-transparent"
                            >
                              <span>All Stats</span>
                              <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SECTION 2: ERRORS VIEW */}
          {activeSection === 'errors' && (
            <div className="bg-[#000000] border border-zinc-800 rounded-2xl shadow-xl overflow-hidden flex flex-col">
              <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-[#000000]">
                <div className="flex items-center gap-3">
                  {renderNavMenu("text-rose-400")}
                  <div>
                    <h2 className="text-base font-semibold text-white tracking-tight flex items-center gap-2">
                      <AlertOctagon className="w-4 h-4 text-rose-500" />
                      <span>Failed Applications</span>
                    </h2>
                    <p className="text-xs text-zinc-400">Inspection list for jobs that encountered errors ({fromDate} to {toDate})</p>
                  </div>
                </div>
                <button
                  onClick={fetchErrors}
                  disabled={loadingErrors}
                  className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                  title="Refresh Errors"
                >
                  <RefreshCw className={`w-4 h-4 ${loadingErrors ? 'animate-spin' : ''}`} />
                </button>
              </div>

              <div className="overflow-x-auto min-h-[450px]">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#000000] text-zinc-400 uppercase tracking-wider font-semibold border-b border-zinc-800">
                    <tr>
                      <th className="px-6 py-3.5">Timestamp</th>
                      <th className="px-6 py-3.5">ApplyWizz ID</th>
                      <th className="px-6 py-3.5">Job Title & Company</th>
                      <th className="px-6 py-3.5">Failed Reason</th>
                      <th className="px-6 py-3.5 text-right">Job Link</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {loadingErrors ? (
                      <tr>
                        <td colSpan="5" className="px-6 py-12 text-center text-zinc-500">
                          <div className="inline-flex items-center gap-2">
                            <RefreshCw className="w-4 h-4 animate-spin text-rose-500" />
                            <span>Loading failed applications...</span>
                          </div>
                        </td>
                      </tr>
                    ) : errors.length === 0 ? (
                      <tr>
                        <td colSpan="5" className="px-6 py-12 text-center text-zinc-500">
                          No failed jobs found for the selected date window. Clean run!
                        </td>
                      </tr>
                    ) : (
                      errors.map((err, i) => (
                        <tr key={i} className="hover:bg-zinc-800/30 transition-colors">
                          <td className="px-6 py-3.5 whitespace-nowrap text-zinc-500 font-mono text-[11px]">
                            {err.time ? format(new Date(err.time), 'MMM d, HH:mm:ss') : '-'}
                          </td>
                          <td className="px-6 py-3.5 font-mono text-zinc-200">
                            {err.applywizz_id}
                          </td>
                          <td className="px-6 py-3.5 max-w-xs">
                            <div className="font-medium text-zinc-200 truncate">{err.name || 'Unknown Role'}</div>
                            <div className="text-[11px] text-zinc-500 truncate">{err.company || 'Unknown Company'}</div>
                          </td>
                          <td className="px-6 py-3.5 max-w-md">
                            <span className="inline-block px-2.5 py-1 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400 font-mono text-[11px] break-words">
                              {err.reason || 'Unknown error occurred'}
                            </span>
                          </td>
                          <td className="px-6 py-3.5 text-right whitespace-nowrap">
                            {err.url ? (
                              <a
                                href={err.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 font-medium hover:underline text-xs"
                              >
                                <span>Open Dice</span>
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : (
                              <span className="text-zinc-600">-</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SECTION 3: LIVE LOGS VIEW */}
          {activeSection === 'logs' && (
            <div className="bg-[#000000] border border-zinc-800 rounded-2xl shadow-xl overflow-hidden flex flex-col h-[650px]">
              <div className="px-6 py-4 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#000000]">
                <div className="flex items-center gap-3">
                  {renderNavMenu("text-emerald-400")}
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-blue-400" />
                    <h2 className="text-base font-semibold text-white tracking-tight">Real-Time System & Worker Logs</h2>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Filter logs..."
                      value={logFilter}
                      onChange={(e) => setLogFilter(e.target.value)}
                      className="pl-8 pr-3 py-1 bg-zinc-950/80 border border-zinc-800 rounded-lg text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500"
                    />
                  </div>

                  <button
                    onClick={() => setAutoScrollLogs(!autoScrollLogs)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${autoScrollLogs
                      ? 'bg-blue-600/20 text-blue-400 border-blue-500/30'
                      : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                      }`}
                  >
                    {autoScrollLogs ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 bg-[#000000] font-mono text-[11px] leading-relaxed space-y-1 select-text">
                {filteredLogs.length === 0 ? (
                  <div className="text-zinc-600 text-center py-20">No matching logs found...</div>
                ) : (
                  filteredLogs.map((l, i) => {
                    const isSystem = l.applywizz_id === 'SYSTEM';
                    const isErr = l.message.includes('ERROR') || l.message.includes('FAILED') || l.message.includes('CRITICAL');
                    const isSuccess = l.message.includes('Completed') || l.message.includes('Finished') || l.message.includes('Found');

                    return (
                      <div key={i} className="flex items-start gap-2 break-all hover:bg-zinc-900/40 px-1 py-0.5 rounded transition-colors">
                        <span className="text-zinc-600 shrink-0">
                          [{format(new Date(l.time), 'HH:mm:ss')}]
                        </span>
                        <span className={`shrink-0 font-semibold ${isSystem ? 'text-amber-400' : 'text-blue-400'}`}>
                          {isSystem ? '[SYSTEM]' : `[${l.applywizz_id}]`}
                        </span>
                        <span className={
                          isErr ? 'text-rose-400 font-medium' : isSuccess ? 'text-emerald-400' : 'text-zinc-300'
                        }>
                          {l.message.replace(`[${l.applywizz_id}] `, '').replace(`[SYSTEM] `, '')}
                        </span>
                      </div>
                    );
                  })
                )}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}

        </main>
      </div>

      {/* 4. "ALL STATS" POP-UP MODAL (CLIENT SPECIFIC) */}
      {selectedClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/80 backdrop-blur-md transition-all">
          <div className="bg-[#000000] border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">

            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-[#000000]">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-white tracking-tight">
                    Client Stats: <span className="text-blue-400 font-mono">{selectedClient.applywizz_id}</span>
                  </h2>
                </div>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {selectedClient.company_email || 'No company email assigned'} &bull; Date: {fromDate} to {toDate}
                </p>
              </div>

              <button
                onClick={() => setSelectedClient(null)}
                className="p-1.5 hover:bg-zinc-800 rounded-xl text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-6 overflow-y-auto flex-1">

              {/* Client Top Stats (4 Metric Boxes) */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-[#000000] border border-zinc-800 rounded-xl p-3">
                  <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">Completed</p>
                  <p className="text-xl font-bold text-zinc-100 mt-1">{clientCompleted}</p>
                </div>
                <div className="bg-[#000000] border border-zinc-800 rounded-xl p-3">
                  <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">Zoho Skipped</p>
                  <p className="text-xl font-bold text-amber-400 mt-1">{clientZohoSkipped}</p>
                </div>
                <div className="bg-[#000000] border border-zinc-800 rounded-xl p-3">
                  <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">Clean Completed</p>
                  <p className="text-xl font-bold text-emerald-400 mt-1">{clientCleanCompleted}</p>
                </div>
                <div className="bg-[#000000] border border-zinc-800 rounded-xl p-3">
                  <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">Failed</p>
                  <p className="text-xl font-bold text-rose-400 mt-1">{clientFailed}</p>
                </div>
              </div>

              {/* Status Filter Tabs */}
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 pb-3">
                <button
                  onClick={() => setClientFilter('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${clientFilter === 'all'
                    ? 'bg-zinc-100 text-zinc-950'
                    : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'
                    }`}
                >
                  All ({clientJobs.length})
                </button>
                <button
                  onClick={() => setClientFilter('completed')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${clientFilter === 'completed'
                    ? 'bg-blue-600 text-white'
                    : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'
                    }`}
                >
                  Completed ({clientCompleted})
                </button>
                <button
                  onClick={() => setClientFilter('zoho_skipped')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${clientFilter === 'zoho_skipped'
                    ? 'bg-amber-600 text-white'
                    : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'
                    }`}
                >
                  Zoho Skipped ({clientZohoSkipped})
                </button>
                <button
                  onClick={() => setClientFilter('clean')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${clientFilter === 'clean'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'
                    }`}
                >
                  Clean Completed ({clientCleanCompleted})
                </button>
                <button
                  onClick={() => setClientFilter('failed')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${clientFilter === 'failed'
                    ? 'bg-rose-600 text-white'
                    : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'
                    }`}
                >
                  Failed ({clientFailed})
                </button>
              </div>

              {/* Jobs Table */}
              <div className="border border-zinc-800 rounded-xl overflow-hidden">
                <div className="overflow-x-auto max-h-[350px]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#000000] text-zinc-400 uppercase tracking-wider font-semibold sticky top-0 border-b border-zinc-800">
                      <tr>
                        <th className="px-4 py-3">Time</th>
                        <th className="px-4 py-3">Company</th>
                        <th className="px-4 py-3">Job Title</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60 bg-[#000000]">
                      {loadingJobs ? (
                        <tr>
                          <td colSpan="5" className="px-4 py-10 text-center text-zinc-500">
                            <div className="inline-flex items-center gap-2">
                              <RefreshCw className="w-4 h-4 animate-spin text-blue-500" />
                              <span>Loading client history...</span>
                            </div>
                          </td>
                        </tr>
                      ) : filteredClientJobs.length === 0 ? (
                        <tr>
                          <td colSpan="5" className="px-4 py-10 text-center text-zinc-500">
                            No jobs found matching this status filter.
                          </td>
                        </tr>
                      ) : (
                        filteredClientJobs.map((job, idx) => (
                          <tr key={idx} className="hover:bg-zinc-800/30 transition-colors">
                            <td className="px-4 py-3 whitespace-nowrap text-zinc-500 font-mono text-[11px]">
                              {job.time ? format(new Date(job.time), 'MMM d, HH:mm') : '-'}
                            </td>
                            <td className="px-4 py-3 font-medium text-zinc-200">{job.company}</td>
                            <td className="px-4 py-3 text-blue-400 truncate max-w-xs">
                              <a
                                href={job.url}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:underline inline-flex items-center gap-1"
                              >
                                <span>{job.name}</span>
                                <ExternalLink className="w-3 h-3 shrink-0" />
                              </a>
                            </td>
                            <td className="px-4 py-3">
                              {job.status === 'Completed' ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                                  Completed
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-rose-500/10 border border-rose-500/20 text-rose-400">
                                  Failed
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-zinc-400 font-mono text-[11px] max-w-xs truncate" title={job.reason}>
                              {job.reason ? (
                                <span className={job.reason.toLowerCase().includes('zoho') ? 'text-amber-400' : 'text-zinc-300'}>
                                  {job.reason}
                                </span>
                              ) : (
                                <span className="text-zinc-600">-</span>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

            </div>

          </div>
        </div>
      )}

    </div>
  );
}

export default App;
