require('dotenv').config();
const { chromium } = require('playwright');
const { Client } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// --- DATABASE SETUP ---
async function queryDB(text, params) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        const res = await client.query(text, params);
        return res.rows;
    } finally {
        await client.end();
    }
}

// --- AWS S3 SETUP ---
let s3;
if (process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    s3 = new S3Client({
        region: process.env.AWS_REGION,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
    });
}

// --- FILE PATHS (Local overrides/temps) ---
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// --- STATE & QUEUE MANAGEMENT ---
let masterBacklog = [];
let jobQueue = []; 
let activeUsers = new Set();
let activeWorkers = 0;
const MAX_WORKERS = 5;
let globalBrowser = null;
let cooldownTimer = null;

// --- LOGGING HELPERS ---
function sysLog(msg) {
    const text = `[SYSTEM] ${msg}`;
    console.log(text);
    if (process.env.DATABASE_URL) {
        queryDB('INSERT INTO dicev2_logs (applywizz_id, message) VALUES ($1, $2)', ['SYSTEM', text]).catch(() => {});
    }
}
function log(applywizz_id, msg) {
    const text = `[${applywizz_id}] ${msg}`;
    console.log(text);
    if (process.env.DATABASE_URL) {
        queryDB('INSERT INTO dicev2_logs (applywizz_id, message) VALUES ($1, $2)', [applywizz_id, text]).catch(() => {});
    }
}

function printDashboard() {
    console.log(`\n--- ACTIVE WORKERS (${activeWorkers}/${MAX_WORKERS}) ---`);
    if (activeUsers.size > 0) {
        console.log(`Currently processing: [${Array.from(activeUsers).join('], [')}]`);
    } else {
        console.log(`Currently processing: None`);
    }
    const pendingCount = jobQueue.filter(j => j.status === 'PENDING').length;
    const cooldownCount = jobQueue.filter(j => j.status === 'COOLDOWN').length;
    console.log(`Dashboard -> PENDING: ${pendingCount} | COOLDOWN: ${cooldownCount}`);
    console.log(`Master Backlog remaining: ${masterBacklog.length}`);
    console.log(`----------------------------\n`);
}

// --- DB SYNC HELPERS ---
async function syncLiveQueue() {
    if (jobQueue.length === 0) {
        await queryDB('TRUNCATE TABLE dicev2_live_queue');
        return;
    }
    const values = [];
    const flatParams = [];
    let counter = 1;
    for (const j of jobQueue) {
        values.push(`($${counter++}, $${counter++}, $${counter++}, $${counter++})`);
        flatParams.push(j.applywizz_id, j.url, j.status, j.cooldown_until);
    }
    await queryDB('TRUNCATE TABLE dicev2_live_queue');
    await queryDB(`INSERT INTO dicev2_live_queue (applywizz_id, url, status, cooldown_until) VALUES ${values.join(',')}`, flatParams);
}

async function syncMasterBacklog() {
    if (masterBacklog.length === 0) {
        await queryDB('TRUNCATE TABLE dicev2_master_backlog');
        return;
    }
    // PostgreSQL has a limit of 65535 parameters per query. 
    // 3 columns * 1149 rows = 3447, which is perfectly safe.
    const values = [];
    const flatParams = [];
    let counter = 1;
    for (const j of masterBacklog) {
        values.push(`($${counter++}, $${counter++}, $${counter++})`);
        flatParams.push(j.applywizz_id, j.email_id, j.url);
    }
    await queryDB('TRUNCATE TABLE dicev2_master_backlog');
    await queryDB(`INSERT INTO dicev2_master_backlog (applywizz_id, email_id, url) VALUES ${values.join(',')}`, flatParams);
}

async function updateJobStatus(job, newStatus) {
    job.status = newStatus;
    await syncLiveQueue();
}

async function randomWait(applywizz_id, page, minMs, maxMs) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    log(applywizz_id, `[Wait] Sleeping for ${(delay / 1000).toFixed(1)}s...`);
    await page.waitForTimeout(delay);
}

// --- TEXT PARSING HELPERS ---
function normalizeText(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractCleanText(html) {
    if (!html) return '';
    let text = html;
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<br\s*[\/]?>/gi, '\n');
    text = text.replace(/<\/div>|<\/p>|<\/tr>|<\/h[1-6]>/gi, '\n');
    text = text.replace(/<[^>]*>?/gm, '');
    text = text.replace(/&nbsp;/g, ' ')
               .replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>');
    text = text.replace(/\n\s*\n/g, '\n\n').trim();
    return text;
}

// --- ZOHO LOGIC ---
async function precheckZohoConnections(clientsArray) {
    sysLog('Running Zoho API Pre-Check...');
    let apiUsers = [];
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, 15000);
    try {
        const res = await fetch('https://zoho-mail-reader.onrender.com/api/zoho/ui/users', { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        apiUsers = data.users || [];
        sysLog(`Fetched ${apiUsers.length} users from Zoho API.`);
    } catch (err) {
        clearTimeout(timeout);
        sysLog(`ERROR during Zoho Pre-Check: ${err.message}. Defaulting all to unconnected.`);
    }

    // Process unique users only
    const uniqueClients = [];
    const seenEmails = new Set();
    
    for (const client of clientsArray) {
        if (!client || !client.email_id) continue;
        if (seenEmails.has(client.email_id)) continue;
        seenEmails.add(client.email_id);
        
        try {
            const apiUser = apiUsers.find(u => u.email && u.email.toLowerCase() === client.email_id.trim().toLowerCase());
            client.zoho_connected = apiUser ? (apiUser.connected === true) : false;
            uniqueClients.push(client);
        } catch(e) {
            sysLog(`Error matching client ${client.email_id}: ${e.message}`);
        }
    }
    
    sysLog(`Zoho precheck finished processing ${uniqueClients.length} unique clients.`);
    return uniqueClients;
}

async function pollZohoForReceipt(job, jobName, company) {
    const { email_id, applywizz_id } = job;
    await updateJobStatus(job, 'AWAITING_RECEIPT');
    log(applywizz_id, `[Zoho] Starting 10-minute email polling for ${email_id}...`);
    
    const targetFrom = 'applyonline@dice.com';
    const normalizedJobName = normalizeText(jobName);
    
    for (let i = 1; i <= 10; i++) {
        log(applywizz_id, `[Zoho] Attempt ${i}/10 - Checking inbox...`);
        try {
            const inboxUrl = `https://zoho-mail-reader.onrender.com/api/zoho/ui/inbox?email=${encodeURIComponent(email_id)}&limit=10&start=1`;
            const inboxRes = await fetch(inboxUrl);
            if (!inboxRes.ok) throw new Error(`HTTP error! status: ${inboxRes.status}`);
            
            const inboxData = await inboxRes.json();
            const accountId = inboxData.accountId;
            const messages = inboxData.messages || [];
            
            let matchedMessage = null;
            for (const msg of messages) {
                const fromMatch = msg.from && msg.from.includes(targetFrom);
                const jobMatch = normalizeText(msg.subject).includes(normalizedJobName);
                if (fromMatch && jobMatch) {
                    matchedMessage = msg;
                    break;
                }
            }
            
            if (matchedMessage) {
                log(applywizz_id, `[Zoho] Found matching email! Fetching body...`);
                const folderId = matchedMessage.folderId;
                const messageId = matchedMessage.messageId;
                
                const messageUrl = `https://zoho-mail-reader.onrender.com/api/zoho/ui/message?email=${encodeURIComponent(email_id)}&accountId=${accountId}&folderId=${folderId}&messageId=${messageId}`;
                const messageRes = await fetch(messageUrl);
                if (!messageRes.ok) throw new Error(`HTTP error fetching message! status: ${messageRes.status}`);
                
                const messageData = await messageRes.json();
                const rawTimeMs = parseInt(messageData.message.receivedTime);
                const readableDate = new Date(rawTimeMs).toLocaleString(); 

                const cleanReceipt = {
                    from: messageData.message.from,
                    to: messageData.message.to,
                    subject: messageData.message.subject,
                    receivedTime: readableDate,
                    text: extractCleanText(messageData.message.htmlContent)
                };
                
                log(applywizz_id, `[Zoho] Success! Clean Email JSON generated.`);
                return cleanReceipt;
            }
        } catch (err) {
            log(applywizz_id, `[Zoho] Error during polling: ${err.message}`);
        }
        
        if (i < 10) await new Promise(r => setTimeout(r, 60000));
    }
    
    log(applywizz_id, `[Zoho] Timeout reached. No matching email found after 10 minutes.`);
    return 'ZOHO_TIMEOUT';
}

// --- BROWSER AUTOMATION ---
async function runAutomation(job) {
    const { url, applywizz_id, email_id, zoho_connected, job_name, company } = job;
    await updateJobStatus(job, 'PROCESSING');
    log(applywizz_id, `Starting Dice automation for: ${url}`);
    
    let jobStatus = 'Failed';
    let jobReason = 'Unknown error';
    let emailProof = { status: "failed application" };
    
    let contextOptions = {};
    const newSessionPath = path.join(sessionsDir, `${applywizz_id}_session.json`);
    
    try {
        // Fetch session state from Postgres
        const sessionData = await queryDB('SELECT session_state FROM dicev2_sessions WHERE email_id = $1', [email_id]);
        if (sessionData.length > 0 && sessionData[0].session_state) {
            log(applywizz_id, `Using existing PostgreSQL session state.`);
            fs.writeFileSync(newSessionPath, JSON.stringify(sessionData[0].session_state));
            contextOptions.storageState = newSessionPath;
        }
    } catch (dbErr) {
        log(applywizz_id, `Failed to fetch session from DB: ${dbErr.message}`);
    }

    const context = await globalBrowser.newContext(contextOptions);
    const page = await context.newPage();

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await randomWait(applywizz_id, page, 3000, 6000); 

        log(applywizz_id, 'Waiting for Apply button...');
        const applyButton = page.locator('[data-testid="apply-button"]');
        try {
            await applyButton.waitFor({ state: 'visible', timeout: 15000 });
        } catch (e) {
            throw new Error("no_apply_button");
        }
        
        log(applywizz_id, 'Clicking Apply...');
        await applyButton.click();
        await randomWait(applywizz_id, page, 5000, 10000); 
        
        log(applywizz_id, 'Checking if login is required or wizard...');
        const emailInput = page.locator('input[name="email"]').first();
        const nextButton = page.locator('button').filter({ hasText: /^Next$/i }).first();
        const submitButton = page.locator('button').filter({ hasText: /^Submit$/i }).first();
        
        const expectedElement = emailInput.or(nextButton).or(submitButton);
        await expectedElement.waitFor({ state: 'visible', timeout: 30000 });

        if (await emailInput.isVisible()) {
            log(applywizz_id, 'Login page detected. Proceeding with login flow...');
            const password = process.env.DICE_PASSWORD;
            if (!password) throw new Error("DICE_PASSWORD is not set in .env");

            await emailInput.fill(email_id);
            await page.locator('[data-testid="sign-in-button"]').click();
            await randomWait(applywizz_id, page, 3000, 6000); 
            
            const passwordInput = page.locator('input[name="password"]').first();
            await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
            await passwordInput.fill(password);
            
            log(applywizz_id, 'Logging in...');
            await page.locator('[data-testid="submit-password"]').click();
            await randomWait(applywizz_id, page, 5000, 10000); 
            
            const afterLoginElement = nextButton.or(submitButton);
            await afterLoginElement.waitFor({ state: 'visible', timeout: 30000 });
            
            await context.storageState({ path: newSessionPath });
            const savedState = JSON.parse(fs.readFileSync(newSessionPath, 'utf8'));
            
            // Save to Postgres
            await queryDB(`
                INSERT INTO dicev2_sessions (email_id, session_state) 
                VALUES ($1, $2) 
                ON CONFLICT (email_id) DO UPDATE SET session_state = EXCLUDED.session_state
            `, [email_id, JSON.stringify(savedState)]);
            
            log(applywizz_id, `Session state saved to Azure PostgreSQL.`);
        } else {
            log(applywizz_id, 'Already logged in. Wizard page detected.');
        }

        // --- DYNAMIC WIZARD LOOP ---
        let isSubmitted = false;
        let stepCount = 0;
        const maxSteps = 5;

        log(applywizz_id, 'Starting dynamic wizard navigation...');
        while (!isSubmitted && stepCount < maxSteps) {
            stepCount++;
            const nextOrSubmit = nextButton.or(submitButton);
            await nextOrSubmit.waitFor({ state: 'visible', timeout: 15000 });
            
            if (await submitButton.isVisible()) {
                log(applywizz_id, `Submit button found (Step ${stepCount}). Clicking Submit...`);
                await submitButton.click();
                isSubmitted = true;
                await randomWait(applywizz_id, page, 5000, 10000);
            } else if (await nextButton.isVisible()) {
                log(applywizz_id, `Next button found (Step ${stepCount}). Clicking Next...`);
                await nextButton.click();
                await randomWait(applywizz_id, page, 10000, 15000);
            } else {
                throw new Error("Wizard navigation failed: Neither Next nor Submit was found.");
            }
        }
        
        if (!isSubmitted) {
            throw new Error(`Stuck on wizard: Exceeded ${maxSteps} steps without finding Submit.`);
        }

        log(applywizz_id, 'Taking screenshot and sending to AWS S3...');
        const finalUrl = page.url();
        await page.evaluate((url) => {
            const b = document.createElement('div');
            b.innerText = `Captured URL: ${url}`;
            Object.assign(b.style, {
                position: 'fixed', top: '0', left: '0', width: '100%',
                backgroundColor: 'rgba(0,0,0,0.8)', color: 'white', padding: '15px',
                fontSize: '18px', fontWeight: 'bold', zIndex: '2147483647', textAlign: 'center'
            });
            document.body.appendChild(b);
        }, finalUrl);

        const screenshotBuffer = await page.screenshot({ fullPage: true });
        
        // Push to AWS S3
        if (s3 && process.env.AWS_BUCKET_NAME && process.env.AWS_S3_BASE_PATH) {
            const safeCompany = company ? company.replace(/[/\\?%*:|"<>\x00-\x1F]/g, '-') : 'UnknownCompany';
            const safeJobName = job_name ? job_name.replace(/[/\\?%*:|"<>\x00-\x1F]/g, '-') : 'UnknownJob';
            const objectKey = `${process.env.AWS_S3_BASE_PATH}/${applywizz_id}/${applywizz_id}|${safeCompany}|${safeJobName}.png`;
            
            await s3.send(new PutObjectCommand({
                Bucket: process.env.AWS_BUCKET_NAME,
                Key: objectKey,
                Body: screenshotBuffer,
                ContentType: 'image/png'
            }));
            log(applywizz_id, `Screenshot securely uploaded to S3: ${objectKey}`);
        } else {
            log(applywizz_id, `WARNING: S3 missing config. Skipping upload.`);
        }
        
        if (zoho_connected) {
            const zohoRes = await pollZohoForReceipt(job, job_name, company);
            jobStatus = 'Completed';
            if (zohoRes === 'ZOHO_TIMEOUT' || typeof zohoRes === 'string') {
                jobReason = 'zoho skipped';
                emailProof = { status: "failed to fetch" };
            } else {
                jobReason = '';
                emailProof = zohoRes;
            }
        } else {
            jobStatus = 'Completed';
            jobReason = 'zoho skipped';
            emailProof = { status: "not connected" };
        }
        
    } catch (error) {
        log(applywizz_id, `ERROR: ${error.message}`);
        jobStatus = 'Failed';
        jobReason = error.message;
        emailProof = { status: "failed application" };
    } finally {
        await page.close();
        await context.close();
        
        // Write exactly to Azure DB specifications
        try {
            await queryDB(`
                INSERT INTO dicev2_applied_jobs (applywizz_id, url, name, company, status, reason, email_proof)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [applywizz_id, url, job_name, company, jobStatus, jobReason, JSON.stringify(emailProof)]);
            log(applywizz_id, `Job Finished with status: ${jobStatus}. Saved to PostgreSQL.`);
            
            if (jobStatus === 'Completed') {
                clientSuccessCounts[applywizz_id] = (clientSuccessCounts[applywizz_id] || 0) + 1;
                await queryDB(`
                    INSERT INTO dicev2_client_counters (applywizz_id, completed_count) 
                    VALUES ($1, 1) 
                    ON CONFLICT (applywizz_id) DO UPDATE 
                    SET completed_count = dicev2_client_counters.completed_count + 1
                `, [applywizz_id]).catch(()=>{});
            }
        } catch(dbSaveErr) {
            log(applywizz_id, `CRITICAL DB ERROR saving job result: ${dbSaveErr.message}`);
        }

        // Dashboard Queue Replacement
        const jobIndex = jobQueue.findIndex(j => j.id === job.id);
        if (jobIndex !== -1) jobQueue.splice(jobIndex, 1);

        if ((clientSuccessCounts[applywizz_id] || 0) >= 10) {
            log(applywizz_id, `Client reached 10 completed jobs! Dropping remaining backlog.`);
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
                log(applywizz_id, `Next job pulled. On 20-30 min COOLDOWN until ${nextJob.cooldown_until}`);
            }
        }
        
        await syncLiveQueue();
        await syncMasterBacklog();
        
        activeUsers.delete(applywizz_id);
        activeWorkers--;
        printDashboard();
        checkQueue();
    }
}

// --- QUEUE MANAGER ---
async function checkQueue() {
    if (activeWorkers >= MAX_WORKERS) return;

    const nextJob = jobQueue.find(j => j.status === 'PENDING' && !activeUsers.has(j.applywizz_id));
    if (!nextJob) return; 

    activeUsers.add(nextJob.applywizz_id);
    activeWorkers++;
    printDashboard();

    runAutomation(nextJob).finally(() => {});
    checkQueue();
}

function startCooldownEngine() {
    cooldownTimer = setInterval(async () => {
        let changed = false;
        const now = Date.now();
        
        for (const job of jobQueue) {
            if (job.status === 'COOLDOWN' && now >= job.cooldown_until_ms) {
                job.status = 'PENDING';
                job.cooldown_until = '';
                job.cooldown_until_ms = 0;
                changed = true;
                log(job.applywizz_id, `Cooldown finished! Job is now PENDING.`);
            }
        }
        
        if (changed) {
            await syncLiveQueue();
            checkQueue(); 
        }

        if (jobQueue.length === 0 && masterBacklog.length === 0 && activeWorkers === 0) {
            clearInterval(cooldownTimer);
            sysLog("All queues empty and all jobs complete. Shutting down browser.");
            if (globalBrowser) await globalBrowser.close();
            // Do not process.exit(0) here because the Railway server must stay alive for the next Cron!
            sysLog("Standing by for next Cron trigger...");
        }
    }, 10000); 
}

// --- INITIALIZATION ---
async function initializeDatabase() {
    sysLog('Initializing Azure PostgreSQL tables if not exist...');
    await queryDB(`
        CREATE TABLE IF NOT EXISTS dicev2_sessions (
            email_id VARCHAR PRIMARY KEY,
            session_state JSONB
        );
        CREATE TABLE IF NOT EXISTS dicev2_live_queue (
            id SERIAL PRIMARY KEY,
            applywizz_id VARCHAR,
            url VARCHAR,
            status VARCHAR,
            cooldown_until VARCHAR
        );
        CREATE TABLE IF NOT EXISTS dicev2_master_backlog (
            id SERIAL PRIMARY KEY,
            applywizz_id VARCHAR,
            email_id VARCHAR,
            url VARCHAR
        );
        CREATE TABLE IF NOT EXISTS dicev2_applied_jobs (
            id SERIAL PRIMARY KEY,
            applywizz_id VARCHAR,
            url VARCHAR,
            name VARCHAR,
            company VARCHAR,
            status VARCHAR,
            reason VARCHAR,
            time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            email_proof JSONB
        );
        CREATE TABLE IF NOT EXISTS dicev2_logs (
            id SERIAL PRIMARY KEY,
            applywizz_id VARCHAR,
            message TEXT,
            time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ); 
        CREATE TABLE IF NOT EXISTS dicev2_client_counters (
            applywizz_id VARCHAR PRIMARY KEY,
            completed_count INT DEFAULT 0
        );
    `);
}

let clientSuccessCounts = {};

async function startJobRun(isFresh = true) {
    if (jobQueue.length > 0 || masterBacklog.length > 0) {
        sysLog('WARNING: Previous run is still active. Skipping this Cron trigger.');
        return;
    }
    sysLog('=== STARTING SCHEDULED JOB RUN ===');
    
    if (isFresh) {
        await queryDB('UPDATE dicev2_client_counters SET completed_count = 0').catch(()=>{});
        clientSuccessCounts = {};
    } else {
        try {
            const dbCounts = await queryDB('SELECT applywizz_id, completed_count FROM dicev2_client_counters');
            for (const row of dbCounts) {
                clientSuccessCounts[row.applywizz_id] = parseInt(row.completed_count, 10);
            }
        } catch(e){}
    }
    
    if (!process.env.DATABASE_URL) {
        sysLog('CRITICAL ERROR: DATABASE_URL not set in .env');
        return;
    }

    await initializeDatabase();
    await queryDB('TRUNCATE TABLE dicev2_live_queue, dicev2_master_backlog');

    // 1. Fetch valid jobs < 12 hours old
    const rawJobs = await queryDB(`
        SELECT d.url, d.applywizz_id, d.title as job_name, d.company, c.company_email as email_id
        FROM dice_scraped_jobs d
        JOIN clients_additional_info c ON d.applywizz_id = c.applywizz_id
        WHERE d.scraped_at > NOW() - INTERVAL '12 hours'
          AND NOT EXISTS (
              SELECT 1 FROM dicev2_applied_jobs a 
              WHERE a.url = d.url AND a.applywizz_id = d.applywizz_id
          );
    `);
    
    if (rawJobs.length === 0) {
        sysLog('No valid fresh jobs found in DB. Standing by.');
        return;
    }

    sysLog(`Fetched ${rawJobs.length} fresh jobs from DB.`);

    // 2. Zoho Precheck
    const clientsToPrecheck = rawJobs.map(r => ({ email_id: r.email_id, applywizz_id: r.applywizz_id }));
    const precheckedClients = await precheckZohoConnections(clientsToPrecheck);
    
    let jobIdCounter = 1;
    for (const row of rawJobs) {
        const client = precheckedClients.find(c => c.applywizz_id === row.applywizz_id);
        masterBacklog.push({
            id: jobIdCounter++,
            applywizz_id: row.applywizz_id,
            email_id: row.email_id,
            zoho_connected: client ? client.zoho_connected : false,
            url: row.url,
            job_name: row.job_name,
            company: row.company,
            status: 'PENDING',
            cooldown_until: '',
            cooldown_until_ms: 0
        });
    }

    // 3. Initialize the Dashboard (Exactly 1 job per unique user)
    const uniqueUsers = [...new Set(masterBacklog.map(j => j.applywizz_id))];
    for (const uid of uniqueUsers) {
        const nextIdx = masterBacklog.findIndex(j => j.applywizz_id === uid);
        if (nextIdx !== -1) {
            const job = masterBacklog.splice(nextIdx, 1)[0];
            jobQueue.push(job);
        }
    }

    await syncMasterBacklog();
    await syncLiveQueue(); 
    startCooldownEngine();

    sysLog('Launching global Chromium browser...');
    const isHeadless = process.env.HEADLESS !== 'false'; // Default true for Railway server
    globalBrowser = await chromium.launch({ headless: isHeadless });
    
    sysLog('Starting Queue Manager...');
    checkQueue();
}

// --- EXPRESS DASHBOARD SERVER ---
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', async (req, res) => {
    try {
        const { from, to } = req.query;
        let timeFilter = "";
        const params = [];
        if (from && to) {
            // we assume from/to are valid timestamp strings
            timeFilter = "WHERE time >= $1 AND time <= $2";
            params.push(from, to);
        }
        
        const clientsRes = await queryDB(`
            SELECT applywizz_id, 
                   SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) as completed_count,
                   SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) as failed_count
            FROM dicev2_applied_jobs
            ${timeFilter}
            GROUP BY applywizz_id
        `, params);

        const totalRes = await queryDB(`
            SELECT 
                   SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) as total_completed,
                   SUM(CASE WHEN status = 'Failed' THEN 1 ELSE 0 END) as total_failed
            FROM dicev2_applied_jobs
            ${timeFilter}
        `, params);

        res.json({
            totals: totalRes[0] || { total_completed: 0, total_failed: 0 },
            clients: clientsRes
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/jobs/:applywizz_id', async (req, res) => {
    try {
        const { applywizz_id } = req.params;
        const { from, to } = req.query;
        let timeFilter = "";
        const params = [applywizz_id];
        if (from && to) {
            timeFilter = "AND time >= $2 AND time <= $3";
            params.push(from, to);
        }

        const jobs = await queryDB(`
            SELECT * FROM dicev2_applied_jobs
            WHERE applywizz_id = $1 ${timeFilter}
            ORDER BY time DESC
        `, params);
        res.json(jobs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/logs', async (req, res) => {
    try {
        const logs = await queryDB(`
            SELECT * FROM dicev2_logs
            ORDER BY time DESC
            LIMIT 500
        `);
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/trigger', express.json(), async (req, res) => {
    try {
        if (jobQueue.length > 0 || masterBacklog.length > 0) {
            return res.status(400).json({ error: 'A job run is already currently active.' });
        }
        const isFresh = req.body && req.body.mode === 'fresh';
        sysLog(`Manual trigger activated via Dashboard. Mode: ${isFresh ? 'FRESH' : 'RESUME'}`);
        
        // Fire and forget so we don't hold the HTTP request open for hours
        startJobRun(isFresh).catch(err => sysLog(`MANUAL RUN ERROR: ${err.message}`));
        
        res.json({ message: 'Automation started successfully.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


async function upsertTable(tableName, dataObj) {
    if (!dataObj || Object.keys(dataObj).length === 0) return;
    const keys = Object.keys(dataObj);
    const values = Object.values(dataObj);
    
    const cols = keys.map(k => `"${k}"`).join(', ');
    const vals = keys.map((_, i) => '$' + (i + 1)).join(', ');
    
    const updates = keys.filter(k => k !== 'id')
                        .map(k => `"${k}" = EXCLUDED."${k}"`)
                        .join(', ');
    
    const query = `
        INSERT INTO ${tableName} (${cols})
        VALUES (${vals})
        ON CONFLICT (id) DO UPDATE SET ${updates}
    `;
    await queryDB(query, values);
}

function parseArrayIfNeeded(val) {
    if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
        try { return JSON.parse(val); } catch(e) {}
    }
    return val;
}

function mapClientKeys(client) {
    const mapped = {};
    for (const [k, v] of Object.entries(client)) {
        let key = k;
        if (k === 'created_at') key = 'crm_created_at';
        else if (k === 'update_at') key = 'crm_updated_at';
        else if (k === 'careerassociateid') key = 'career_associate_id';
        else if (k === 'scraperid') key = 'scraper_id';
        else if (k === 'careerassociatemanagerid') key = 'career_associate_manager_id';
        else if (k === 'clientofficeid') key = 'client_office_id';
        else if (k === 'onboardingdate') key = 'onboarding_date';
        
        mapped[key] = parseArrayIfNeeded(v);
    }
    
    // Satisfy NOT NULL constraints in DB
    mapped.raw_payload = JSON.stringify(client);
    mapped.imported_at = new Date().toISOString();
    
    return mapped;
}

function mapProfileKeys(profile) {
    const mapped = {};
    for (const [k, v] of Object.entries(profile)) {
        let key = k;
        if (k === 'created_at') key = 'crm_created_at';
        else if (k === 'updated_at') key = 'crm_updated_at';
        
        mapped[key] = parseArrayIfNeeded(v);
    }
    
    // Satisfy NOT NULL constraints in DB
    mapped.raw_payload = JSON.stringify(profile);
    if (!mapped['Time Zone']) mapped['Time Zone'] = 'UTC';
    
    return mapped;
}

async function syncClientsTask() {
    sysLog('Starting Client Sync Process...');
    try {
        const res1 = await fetch('https://applywizz-ca-management.vercel.app/api/active-clients');
        const data1 = await res1.json();
        const activeIds = data1.applywizz_ids || [];
        
        if (activeIds.length === 0) {
            sysLog('No active clients found in API.');
            return;
        }

        const dbRes = await queryDB("SELECT applywizz_id FROM clients_additional_info WHERE applywizz_id IS NOT NULL");
        let toDelete = dbRes.map(row => row.applywizz_id);
        
        const batchSize = 5;
        for (let i = 0; i < activeIds.length; i += batchSize) {
            const batch = activeIds.slice(i, i + batchSize);
            await Promise.all(batch.map(async (id) => {
                try {
                    const r = await fetch(`https://www.apply-wizz.me/api/get-client-details?applywizz_id=${id}`);
                    const data2 = await r.json();
                    
                    if (data2.client) {
                        const mappedClient = mapClientKeys(data2.client);
                        await upsertTable('clients_additional_info', mappedClient);
                    }
                    if (data2.additional_information) {
                        const mappedProfile = mapProfileKeys(data2.additional_information);
                        await upsertTable('client_profiles', mappedProfile);
                    }
                    
                    toDelete = toDelete.filter(existing => existing !== id);
                } catch (err) {
                    sysLog(`Failed to sync client ${id}: ${err.message}`);
                }
            }));
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        if (toDelete.length > 0) {
            sysLog(`Removing ${toDelete.length} inactive clients from DB.`);
            const placeholders = toDelete.map((_, i) => `$${i+1}`).join(',');
            
            // Delete safely catching errors in case of FK constraints
            await queryDB(`DELETE FROM clients_additional_info WHERE applywizz_id IN (${placeholders})`, toDelete).catch(e => sysLog("Delete CAI Error: " + e.message));
            await queryDB(`DELETE FROM client_profiles WHERE applywizz_id IN (${placeholders})`, toDelete).catch(e => sysLog("Delete CP Error: " + e.message));
        }
        
        sysLog('Client Sync Process Complete!');
    } catch (e) {
        sysLog(`SYNC ERROR: ${e.message}`);
    }
}

app.post('/api/sync-clients', async (req, res) => {
    sysLog('Client Sync activated via Dashboard.');
    syncClientsTask().catch(err => sysLog(`SYNC RUN ERROR: ${err.message}`));
    res.json({ message: 'Sync started successfully.' });
});

app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SYSTEM] Dashboard server running on port ${PORT}`);
});

// --- SERVER ENTRY POINT ---
initializeDatabase().catch(e => console.error("DB Init Error:", e));

if (process.env.CRON_SCHEDULE) {
    sysLog(`Starting Railway Node-Cron Scheduler: ${process.env.CRON_SCHEDULE}`);
    cron.schedule(process.env.CRON_SCHEDULE, () => {
        startJobRun(true).catch(err => sysLog(`CRON ERROR: ${err.message}`));
    });
} else {
    sysLog('No CRON_SCHEDULE provided. Running immediately for testing.');
    startJobRun(true).catch(err => sysLog(`RUN ERROR: ${err.message}`));
}
