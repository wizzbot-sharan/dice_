const fs = require('fs');
let code = fs.readFileSync('worker.js', 'utf8');

// 1. Database table creation
code = code.replace(
    /CREATE TABLE IF NOT EXISTS dicev2_logs[^;]+;/g, 
    "$& \n        CREATE TABLE IF NOT EXISTS dicev2_client_counters (\n            applywizz_id VARCHAR PRIMARY KEY,\n            completed_count INT DEFAULT 0\n        );"
);

// 2. Global variable and startJobRun
code = code.replace(
    "async function startJobRun() {",
    "let clientSuccessCounts = {};\n\nasync function startJobRun(isFresh = true) {"
);

code = code.replace(
    "sysLog('=== STARTING SCHEDULED JOB RUN ===');",
    "sysLog('=== STARTING SCHEDULED JOB RUN ===');\n    \n    if (isFresh) {\n        await queryDB('UPDATE dicev2_client_counters SET completed_count = 0').catch(()=>{});\n        clientSuccessCounts = {};\n    } else {\n        try {\n            const dbCounts = await queryDB('SELECT applywizz_id, completed_count FROM dicev2_client_counters');\n            for (const row of dbCounts) {\n                clientSuccessCounts[row.applywizz_id] = parseInt(row.completed_count, 10);\n            }\n        } catch(e){}\n    }"
);

// 3. Process Job DB Logic (Line ~430)
const origDbSave = "log(applywizz_id, `Job Finished with status: ${jobStatus}. Saved to PostgreSQL.`);";
const newDbSave = `log(applywizz_id, \`Job Finished with status: \${jobStatus}. Saved to PostgreSQL.\`);
            
            if (jobStatus === 'Completed') {
                clientSuccessCounts[applywizz_id] = (clientSuccessCounts[applywizz_id] || 0) + 1;
                await queryDB(\`
                    INSERT INTO dicev2_client_counters (applywizz_id, completed_count) 
                    VALUES ($1, 1) 
                    ON CONFLICT (applywizz_id) DO UPDATE 
                    SET completed_count = dicev2_client_counters.completed_count + 1
                \`, [applywizz_id]).catch(()=>{});
            }`;
code = code.replace(origDbSave, newDbSave);

// 4. Job Pulling / Drop logic
const origJobReplace = `const nextJobIndex = masterBacklog.findIndex(j => j.applywizz_id === applywizz_id);
        if (nextJobIndex !== -1) {
            const nextJob = masterBacklog.splice(nextJobIndex, 1)[0];
            const delayMs = Math.floor(Math.random() * (30 - 20 + 1) + 20) * 60 * 1000;
            const targetTime = Date.now() + delayMs;
            
            nextJob.status = 'COOLDOWN';
            nextJob.cooldown_until_ms = targetTime;
            nextJob.cooldown_until = new Date(targetTime).toLocaleTimeString(); 
            
            jobQueue.push(nextJob);
            log(applywizz_id, \`Next job pulled. On 20-30 min COOLDOWN until \${nextJob.cooldown_until}\`);
        }`;
        
const newJobReplace = `if ((clientSuccessCounts[applywizz_id] || 0) >= 10) {
            log(applywizz_id, \`Client reached 10 completed jobs! Dropping remaining backlog.\`);
            for (let i = masterBacklog.length - 1; i >= 0; i--) {
                if (masterBacklog[i].applywizz_id === applywizz_id) {
                    masterBacklog.splice(i, 1);
                }
            }
        } else {
            const nextJobIndex = masterBacklog.findIndex(j => j.applywizz_id === applywizz_id);
            if (nextJobIndex !== -1) {
                const nextJob = masterBacklog.splice(nextJobIndex, 1)[0];
                const delayMs = Math.floor(Math.random() * (30 - 20 + 1) + 20) * 60 * 1000;
                const targetTime = Date.now() + delayMs;
                
                nextJob.status = 'COOLDOWN';
                nextJob.cooldown_until_ms = targetTime;
                nextJob.cooldown_until = new Date(targetTime).toLocaleTimeString(); 
                
                jobQueue.push(nextJob);
                log(applywizz_id, \`Next job pulled. On 20-30 min COOLDOWN until \${nextJob.cooldown_until}\`);
            }
        }`;
code = code.replace(origJobReplace, newJobReplace);

// 5. Update Express Route
const origRoute = `app.post('/api/trigger', async (req, res) => {
    try {
        if (jobQueue.length > 0 || masterBacklog.length > 0) {
            return res.status(400).json({ error: 'A job run is already currently active.' });
        }
        sysLog('Manual trigger activated via Dashboard.');
        
        // Fire and forget so we don't hold the HTTP request open for hours
        startJobRun().catch(err => sysLog(\`MANUAL RUN ERROR: \${err.message}\`));`;
        
const newRoute = `app.post('/api/trigger', express.json(), async (req, res) => {
    try {
        if (jobQueue.length > 0 || masterBacklog.length > 0) {
            return res.status(400).json({ error: 'A job run is already currently active.' });
        }
        const isFresh = req.body && req.body.mode === 'fresh';
        sysLog(\`Manual trigger activated via Dashboard. Mode: \${isFresh ? 'FRESH' : 'RESUME'}\`);
        
        // Fire and forget so we don't hold the HTTP request open for hours
        startJobRun(isFresh).catch(err => sysLog(\`MANUAL RUN ERROR: \${err.message}\`));`;
code = code.replace(origRoute, newRoute);

// Also need to make sure express.json() is parsed? Wait, in worker.js it already has `app.use(express.json());` Wait, let's verify if `app.use(express.json())` is there. If not, adding it inline in the route like I did `app.post('/api/trigger', express.json(), ...)` is perfect.

// Update the cron to be fresh
const origCron = `cron.schedule(process.env.CRON_SCHEDULE, () => {
        startJobRun().catch(err => sysLog(\`CRON ERROR: \${err.message}\`));`;
const newCron = `cron.schedule(process.env.CRON_SCHEDULE, () => {
        startJobRun(true).catch(err => sysLog(\`CRON ERROR: \${err.message}\`));`;
code = code.replace(origCron, newCron);

const origDev = `startJobRun().catch(err => sysLog(\`RUN ERROR: \${err.message}\`));`;
const newDev = `startJobRun(true).catch(err => sysLog(\`RUN ERROR: \${err.message}\`));`;
// careful with this replacement to only replace the exact startup call
code = code.replace(origDev, newDev);


fs.writeFileSync('worker.js', code);
console.log('worker.js patched');
