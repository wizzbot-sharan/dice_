import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { Activity, CheckCircle, XCircle, Users, Calendar, X, Play } from 'lucide-react';

function App() {
  const [stats, setStats] = useState({ totals: { total_completed: 0, total_failed: 0 }, clients: [] });
  const [logs, setLogs] = useState([]);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientJobs, setClientJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isTriggering, setIsTriggering] = useState(false);

  const triggerAutomation = async () => {
    if (!window.confirm("Are you sure you want to manually trigger the automation?")) return;
    setIsTriggering(true);
    try {
      const res = await fetch('/api/trigger', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(`Error: ${data.error}`);
      } else {
        alert('Automation started! Watch the Live System Logs.');
      }
    } catch (e) {
      alert('Failed to trigger automation.');
    }
    setIsTriggering(false);
  };

  const fetchStats = async () => {
    setLoading(true);
    let url = '/api/stats?';
    if (fromDate && toDate) {
      url += `from=${fromDate}&to=${toDate} 23:59:59`;
    }
    try {
      const res = await fetch(url);
      const data = await res.json();
      setStats({
        totals: data.totals || { total_completed: 0, total_failed: 0 },
        clients: Array.isArray(data.clients) ? data.clients : []
      });
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      const data = await res.json();
      setLogs(Array.isArray(data) ? data : []);
    } catch (e) {}
  };

  const openClientModal = async (clientId) => {
    setSelectedClient(clientId);
    setClientJobs([]);
    let url = `/api/jobs/${encodeURIComponent(clientId)}?`;
    if (fromDate && toDate) {
      url += `from=${fromDate}&to=${toDate} 23:59:59`;
    }
    try {
      const res = await fetch(url);
      const data = await res.json();
      setClientJobs(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchStats();
    fetchLogs();
    const interval = setInterval(() => {
      fetchLogs();
    }, 5000);
    return () => clearInterval(interval);
  }, [fromDate, toDate]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-900">ApplyWizz Dashboard</h1>
            <p className="text-gray-500">Real-time automation statistics</p>
          </div>
          
          <div className="flex items-center gap-4">
            <button 
              onClick={triggerAutomation}
              disabled={isTriggering}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
            >
              <Play className="w-4 h-4" />
              {isTriggering ? 'Starting...' : 'Run Automation'}
            </button>

            <div className="flex items-center gap-2 bg-white p-2 rounded-lg shadow-sm border border-gray-100">
              <Calendar className="w-5 h-5 text-gray-400 ml-2" />
              <input 
                type="date" 
                value={fromDate} 
                onChange={e => setFromDate(e.target.value)}
                className="px-2 py-1 outline-none text-sm bg-transparent"
              />
              <span className="text-gray-300">-</span>
              <input 
                type="date" 
                value={toDate} 
                onChange={e => setToDate(e.target.value)}
                className="px-2 py-1 outline-none text-sm bg-transparent"
              />
            </div>
          </div>
        </div>

        {/* Top Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 flex items-center">
            <div className="p-3 bg-blue-50 text-blue-600 rounded-lg">
              <Users className="w-8 h-8" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Active Clients</p>
              <h3 className="text-2xl font-bold">{stats.clients.length}</h3>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 flex items-center">
            <div className="p-3 bg-green-50 text-green-600 rounded-lg">
              <CheckCircle className="w-8 h-8" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Completed</p>
              <h3 className="text-2xl font-bold">{stats.totals.total_completed || 0}</h3>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 flex items-center">
            <div className="p-3 bg-red-50 text-red-600 rounded-lg">
              <XCircle className="w-8 h-8" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Failed</p>
              <h3 className="text-2xl font-bold">{stats.totals.total_failed || 0}</h3>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Client List */}
          <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-semibold">Client Overview</h2>
            </div>
            <div className="overflow-x-auto h-[600px]">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-gray-500 sticky top-0 shadow-sm">
                  <tr>
                    <th className="px-6 py-3 font-medium">ApplyWizz ID</th>
                    <th className="px-6 py-3 font-medium">Completed</th>
                    <th className="px-6 py-3 font-medium">Failed</th>
                    <th className="px-6 py-3 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading ? (
                    <tr><td colSpan="4" className="px-6 py-4 text-center text-gray-500">Loading stats...</td></tr>
                  ) : stats.clients.length === 0 ? (
                    <tr><td colSpan="4" className="px-6 py-4 text-center text-gray-500">No data found for this period.</td></tr>
                  ) : (
                    stats.clients.map((client, i) => (
                      <tr key={i} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4 font-medium text-gray-900">{client.applywizz_id}</td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700">
                            {client.completed_count || 0}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-50 text-red-700">
                            {client.failed_count || 0}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button 
                            onClick={() => openClientModal(client.applywizz_id)}
                            className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                          >
                            View Jobs &rarr;
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Logs */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col h-[600px]">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Activity className="w-5 h-5 text-blue-500" />
                Live System Logs
              </h2>
            </div>
            <div className="flex-1 overflow-y-auto p-4 bg-gray-900 text-gray-300 font-mono text-xs space-y-1">
              {logs.length === 0 ? (
                <div className="text-gray-500 text-center mt-10">No logs found...</div>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className="break-words">
                    <span className="text-gray-500">[{format(new Date(l.time), 'HH:mm:ss')}]</span>{' '}
                    <span className={l.applywizz_id === 'SYSTEM' ? 'text-yellow-400' : 'text-blue-400'}>
                      {l.applywizz_id === 'SYSTEM' ? '' : `[${l.applywizz_id}] `}
                    </span>
                    <span className={l.message.includes('ERROR') || l.message.includes('FAILED') ? 'text-red-400' : 'text-gray-300'}>
                      {l.message.replace(`[${l.applywizz_id}] `, '').replace(`[SYSTEM] `, '')}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

        </div>
      </div>

      {/* Modal */}
      {selectedClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
              <h2 className="text-lg font-bold text-gray-900">
                Job History: <span className="text-blue-600">{selectedClient}</span>
              </h2>
              <button onClick={() => setSelectedClient(null)} className="p-2 hover:bg-gray-200 rounded-full text-gray-500 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-0">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-gray-500 sticky top-0 shadow-sm">
                  <tr>
                    <th className="px-6 py-3 font-medium">Time</th>
                    <th className="px-6 py-3 font-medium">Company</th>
                    <th className="px-6 py-3 font-medium">Job Title</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {clientJobs.length === 0 ? (
                    <tr><td colSpan="5" className="px-6 py-8 text-center text-gray-500">No jobs found for this client.</td></tr>
                  ) : (
                    clientJobs.map((job, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-6 py-3 whitespace-nowrap text-gray-500">{format(new Date(job.time), 'MMM d, HH:mm')}</td>
                        <td className="px-6 py-3 font-medium text-gray-900">{job.company}</td>
                        <td className="px-6 py-3 text-blue-600 truncate max-w-xs">
                          <a href={job.url} target="_blank" rel="noreferrer" className="hover:underline">{job.name}</a>
                        </td>
                        <td className="px-6 py-3">
                          {job.status === 'Completed' ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">Completed</span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">Failed</span>
                          )}
                        </td>
                        <td className="px-6 py-3 text-gray-500 max-w-xs truncate" title={job.reason}>{job.reason || '-'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export default App;
