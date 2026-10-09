const fs = require('fs');
let code = fs.readFileSync('worker.js', 'utf8');

// 1. Add exec requirement
code = code.replace(
    "const path = require('path');",
    "const path = require('path');\nconst { exec } = require('child_process');"
);

// 2. Add global tracking variables
code = code.replace(
    "let globalBrowser = null;",
    "let globalBrowser = null;\nlet jobsProcessedSinceRestart = 0;\nlet isBrowserRestarting = false;\nconst BROWSER_RESTART_LIMIT = 50;"
);

// 3. Add safe restart logic function
const restartFunc = `
async function performBrowserRestart() {
    try {
        if (globalBrowser) {
            sysLog('Closing Chromium to clear Memory/RAM leak...');
            await globalBrowser.close().catch(()=>{});
            globalBrowser = null;
        }
    } catch (e) {
        sysLog(\`Error closing browser: \${e.message}\`);
    }
    
    sysLog('Relaunching fresh Chromium instance...');
    const isHeadless = process.env.HEADLESS !== 'false';
    globalBrowser = await chromium.launch({ headless: isHeadless });
    
    jobsProcessedSinceRestart = 0;
    isBrowserRestarting = false;
    
    sysLog('Browser restarted successfully. Resuming queue...');
    checkQueue();
}
`;
code = code.replace(
    "async function checkQueue() {",
    restartFunc + "\nasync function checkQueue() {"
);

// 4. Update checkQueue
const oldCheck = `async function checkQueue() {
    if (activeWorkers >= MAX_WORKERS) return;

    const nextJob = jobQueue.find(j => j.status === 'PENDING' && !activeUsers.has(j.applywizz_id));
    if (!nextJob) return; 

    activeUsers.add(nextJob.applywizz_id);
    activeWorkers++;
    printDashboard();

    runAutomation(nextJob).finally(() => {});
    checkQueue();
}`;

const newCheck = `async function checkQueue() {
    if (isBrowserRestarting) {
        if (activeWorkers === 0) await performBrowserRestart();
        return;
    }

    if (jobsProcessedSinceRestart >= BROWSER_RESTART_LIMIT) {
        sysLog(\`Reached \${BROWSER_RESTART_LIMIT} tabs. Pausing queue to safely restart Chromium and free RAM...\`);
        isBrowserRestarting = true;
        if (activeWorkers === 0) await performBrowserRestart();
        return;
    }

    if (activeWorkers >= MAX_WORKERS) return;

    const nextJob = jobQueue.find(j => j.status === 'PENDING' && !activeUsers.has(j.applywizz_id));
    if (!nextJob) return; 

    activeUsers.add(nextJob.applywizz_id);
    activeWorkers++;
    jobsProcessedSinceRestart++;
    printDashboard();

    runAutomation(nextJob).finally(() => {});
    checkQueue();
}`;
code = code.replace(oldCheck, newCheck);

// 5. Update End-of-Run Shutdown
const oldShutdown = `        if (jobQueue.length === 0 && masterBacklog.length === 0 && activeWorkers === 0) {
            clearInterval(cooldownTimer);
            sysLog("All queues empty and all jobs complete. Shutting down browser.");
            if (globalBrowser) await globalBrowser.close();
            // Do not process.exit(0) here because the Railway server must stay alive for the next Cron!
            sysLog("Standing by for next Cron trigger...");
        }`;

const newShutdown = `        if (jobQueue.length === 0 && masterBacklog.length === 0 && activeWorkers === 0) {
            clearInterval(cooldownTimer);
            sysLog("All queues empty and all jobs complete. Initiating Aggressive RAM Cleanup.");
            
            if (globalBrowser) {
                await globalBrowser.close().catch(() => {});
                globalBrowser = null; 
            }
            
            activeUsers.clear();
            clientSuccessCounts = {};
            jobsProcessedSinceRestart = 0;
            isBrowserRestarting = false;
            
            exec('pkill -f chrome', (err) => {
                if (!err) sysLog("Assassinated stray Chrome zombie processes.");
                
                if (global.gc) {
                    global.gc();
                    sysLog("Forced V8 Garbage Collection complete.");
                } else {
                    sysLog("Garbage Collection not exposed.");
                }
                
                sysLog("Chromium terminated and Memory flushed. Standing by for next Cron trigger...");
            });
        }`;
code = code.replace(oldShutdown, newShutdown);

fs.writeFileSync('worker.js', code);
console.log('RAM flush patched');
