import React, { useState, useEffect, useRef } from 'react';
import { format } from 'date-fns';
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
  BarChart3,
  AlertOctagon,
  Terminal,
  Layers,
  Sparkles
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

  // Navigation & View State
  const [activeSection, setActiveSection] = useState('all-stats'); // 'all-stats' | 'errors' | 'logs'
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

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
    } catch (e) {}
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

  // --- RENDER LOGIN VIEW ---
  if (!isAuthenticated) {
    return (
      <div className="relative min-h-screen bg-zinc-950 flex items-center justify-center p-6 text-zinc-100 font-sans selection:bg-blue-600 selection:text-white overflow-hidden">
        
        {/* Responsive Background Images with blur and opacity */}
        <div className="absolute inset-0 pointer-events-none select-none overflow-hidden">
          {/* Desktop background for PC / medium-large displays */}
          <img
            src="/Logo_desktop.png"
            alt="Background"
            className="hidden md:block w-full h-full object-cover object-center filter blur-[4px] scale-105 opacity-55 transition-all"
          />
          {/* Mobile background for mobile devices */}
          <img
            src="/Logo_mobile.png"
            alt="Background"
            className="block md:hidden w-full h-full object-cover object-center filter blur-[4px] scale-105 opacity-55 transition-all"
          />
          {/* Translucent overlay for balanced contrast */}
          <div className="absolute inset-0 bg-zinc-950/50" />
        </div>

        {/* Translucent Login Card */}
        <div className="relative z-10 w-full max-w-md">
          <div className="bg-zinc-900/65 backdrop-blur-md border border-zinc-700/60 rounded-2xl p-8 shadow-2xl">
            
            {/* Header: Just 'Dice Login', no logo */}
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold tracking-tight text-white">Dice Login</h1>
            </div>

            {loginError && (
              <div className="mb-6 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-2 text-red-400 text-xs">
                <AlertOctagon className="w-4 h-4 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Username</label>
                <input
                  type="text"
                  required
                  value={loginUser}
                  onChange={(e) => setLoginUser(e.target.value)}
                  placeholder="admin"
                  className="w-full px-3.5 py-2.5 bg-zinc-950/60 border border-zinc-700/80 rounded-xl text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Password</label>
                <input
                  type="password"
                  required
                  value={loginPass}
                  onChange={(e) => setLoginPass(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full px-3.5 py-2.5 bg-zinc-950/60 border border-zinc-700/80 rounded-xl text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                />
              </div>

              <button
                type="submit"
                disabled={isLoggingIn}
                className="w-full mt-2 py-2.5 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-lg shadow-blue-600/30 transition-all flex items-center justify-center disabled:opacity-50"
              >
                {isLoggingIn ? 'Authenticating...' : 'Sign In'}
              </button>
            </form>

            <div className="mt-8 text-center border-t border-zinc-800/80 pt-4">
              <p className="text-[11px] text-zinc-400">Authorized personnel only &bull; Enterprise Session</p>
            </div>
          </div>
        </div>

      </div>
    );
  }

  // --- RENDER AUTHENTICATED DASHBOARD ---
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-blue-600 selection:text-white flex flex-col">
      
      {/* 1. APPLE-STYLE TOP NAV BAR */}
      <header className="sticky top-0 z-40 backdrop-blur-xl bg-zinc-950/80 border-b border-zinc-800/80 px-4 lg:px-8 py-2.5 transition-all">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          
          {/* Left: Brand Logo & Title */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center shadow-md shadow-blue-500/20">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm tracking-tight text-white">ApplyWizz</span>
                <span className="text-[10px] font-mono tracking-wide px-1.5 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">DICE V2</span>
              </div>
            </div>
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

            {/* Date Range Picker (Default: Today) */}
            <div className="flex items-center gap-1.5 bg-zinc-900/90 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs shadow-inner">
              <Calendar className="w-3.5 h-3.5 text-zinc-400" />
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="bg-transparent text-zinc-200 text-xs outline-none cursor-pointer [color-scheme:dark]"
              />
              <span className="text-zinc-600">→</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="bg-transparent text-zinc-200 text-xs outline-none cursor-pointer [color-scheme:dark]"
              />
              <button
                onClick={() => { setFromDate(todayStr); setToDate(todayStr); }}
                className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                title="Reset to Today"
              >
                Today
              </button>
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
          <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-4 flex items-center justify-between shadow-sm relative overflow-hidden group hover:border-blue-500/40 transition-all">
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
          <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-4 flex items-center justify-between shadow-sm relative overflow-hidden group hover:border-indigo-500/40 transition-all">
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
          <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-4 flex items-center justify-between shadow-sm relative overflow-hidden group hover:border-amber-500/40 transition-all">
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
          <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-4 flex items-center justify-between shadow-sm relative overflow-hidden group hover:border-emerald-500/40 transition-all">
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
          <div className="col-span-2 md:col-span-1 bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-4 flex items-center justify-between shadow-sm relative overflow-hidden group hover:border-rose-500/40 transition-all">
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

        {/* 3. MAIN WORKSPACE WITH LEFT BURGER MENU & ACTIVE SECTION */}
        <div className="flex-1 flex flex-col md:flex-row gap-5 items-start">
          
          {/* LEFT BURGER / SECTION SWITCHER MENU */}
          <aside className="w-full md:w-56 shrink-0 bg-zinc-900/80 border border-zinc-800 rounded-2xl p-3 shadow-lg">
            <div className="flex items-center justify-between px-2 py-1.5 mb-2 border-b border-zinc-800/80">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <Menu className="w-3.5 h-3.5 text-zinc-400" />
                <span>Navigation</span>
              </div>
            </div>

            <nav className="space-y-1">
              {/* Option 1: All Stats (Default) */}
              <button
                onClick={() => setActiveSection('all-stats')}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                  activeSection === 'all-stats'
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-600/20'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <BarChart3 className="w-4 h-4" />
                  <span>All Stats</span>
                </div>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                  activeSection === 'all-stats' ? 'bg-blue-500/50 text-white' : 'bg-zinc-800 text-zinc-400'
                }`}>
                  {stats.clients.length}
                </span>
              </button>

              {/* Option 2: Errors */}
              <button
                onClick={() => setActiveSection('errors')}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                  activeSection === 'errors'
                    ? 'bg-rose-600 text-white shadow-md shadow-rose-600/20'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <AlertOctagon className="w-4 h-4" />
                  <span>Errors</span>
                </div>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                  activeSection === 'errors' ? 'bg-rose-500/50 text-white' : 'bg-rose-500/20 text-rose-400'
                }`}>
                  {stats.totals.total_failed || 0}
                </span>
              </button>

              {/* Option 3: Live Logs */}
              <button
                onClick={() => setActiveSection('logs')}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                  activeSection === 'logs'
                    ? 'bg-zinc-800 text-white border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Terminal className="w-4 h-4" />
                  <span>Live Logs</span>
                </div>
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
              </button>
            </nav>
          </aside>

          {/* MAIN CONTENT AREA */}
          <main className="flex-1 w-full overflow-hidden">
            
            {/* SECTION 1: ALL STATS (DEFAULT VIEW - CLIENT LIST) */}
            {activeSection === 'all-stats' && (
              <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl shadow-xl overflow-hidden flex flex-col">
                <div className="px-6 py-4 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-zinc-900/40">
                  <div>
                    <h2 className="text-base font-semibold text-white tracking-tight">Client Performance Overview</h2>
                    <p className="text-xs text-zinc-400">Date window: {fromDate} to {toDate}</p>
                  </div>
                  <div className="text-xs text-zinc-400">
                    Showing <span className="text-zinc-200 font-semibold">{stats.clients.length}</span> clients
                  </div>
                </div>

                <div className="overflow-x-auto min-h-[450px]">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-zinc-950/60 text-zinc-400 uppercase tracking-wider font-semibold border-b border-zinc-800">
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
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                                (client.completed_count || 0) > 0 
                                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                                  : 'bg-zinc-800/60 text-zinc-500'
                              }`}>
                                {client.completed_count || 0}
                              </span>
                            </td>
                            <td className="px-6 py-3.5 text-center">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                                (client.failed_count || 0) > 0 
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
              <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl shadow-xl overflow-hidden flex flex-col">
                <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/40">
                  <div>
                    <h2 className="text-base font-semibold text-white tracking-tight flex items-center gap-2">
                      <AlertOctagon className="w-4 h-4 text-rose-500" />
                      <span>Failed Applications</span>
                    </h2>
                    <p className="text-xs text-zinc-400">Inspection list for jobs that encountered errors ({fromDate} to {toDate})</p>
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
                    <thead className="bg-zinc-950/60 text-zinc-400 uppercase tracking-wider font-semibold border-b border-zinc-800">
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
              <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl shadow-xl overflow-hidden flex flex-col h-[650px]">
                <div className="px-6 py-4 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-zinc-900/40">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-blue-400" />
                    <h2 className="text-base font-semibold text-white tracking-tight">Real-Time System & Worker Logs</h2>
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
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                        autoScrollLogs 
                          ? 'bg-blue-600/20 text-blue-400 border-blue-500/30' 
                          : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                      }`}
                    >
                      {autoScrollLogs ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 bg-zinc-950 font-mono text-[11px] leading-relaxed space-y-1 select-text">
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

      </div>

      {/* 4. "ALL STATS" POP-UP MODAL (CLIENT SPECIFIC) */}
      {selectedClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/80 backdrop-blur-md transition-all">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/80">
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
                <div className="bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-3">
                  <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">Completed</p>
                  <p className="text-xl font-bold text-zinc-100 mt-1">{clientCompleted}</p>
                </div>
                <div className="bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-3">
                  <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">Zoho Skipped</p>
                  <p className="text-xl font-bold text-amber-400 mt-1">{clientZohoSkipped}</p>
                </div>
                <div className="bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-3">
                  <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">Clean Completed</p>
                  <p className="text-xl font-bold text-emerald-400 mt-1">{clientCleanCompleted}</p>
                </div>
                <div className="bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-3">
                  <p className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">Failed</p>
                  <p className="text-xl font-bold text-rose-400 mt-1">{clientFailed}</p>
                </div>
              </div>

              {/* Status Filter Tabs */}
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 pb-3">
                <button
                  onClick={() => setClientFilter('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    clientFilter === 'all'
                      ? 'bg-zinc-100 text-zinc-950'
                      : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  All ({clientJobs.length})
                </button>
                <button
                  onClick={() => setClientFilter('completed')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    clientFilter === 'completed'
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Completed ({clientCompleted})
                </button>
                <button
                  onClick={() => setClientFilter('zoho_skipped')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    clientFilter === 'zoho_skipped'
                      ? 'bg-amber-600 text-white'
                      : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Zoho Skipped ({clientZohoSkipped})
                </button>
                <button
                  onClick={() => setClientFilter('clean')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    clientFilter === 'clean'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Clean Completed ({clientCleanCompleted})
                </button>
                <button
                  onClick={() => setClientFilter('failed')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    clientFilter === 'failed'
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
                    <thead className="bg-zinc-950/80 text-zinc-400 uppercase tracking-wider font-semibold sticky top-0 border-b border-zinc-800">
                      <tr>
                        <th className="px-4 py-3">Time</th>
                        <th className="px-4 py-3">Company</th>
                        <th className="px-4 py-3">Job Title</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/60 bg-zinc-950/40">
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
