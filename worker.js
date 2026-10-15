require('dotenv').config();
const { chromium } = require('playwright');
const { Client } = require('pg');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

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
const MAX_WORKERS = 10;
let globalBrowser = null;
let jobsProcessedSinceRestart = 0;
let isBrowserRestarting = false;
let isBrowserIdleClosed = false;
const BROWSER_RESTART_LIMIT = 50;
let cooldownTimer = null;
let backlogPollerInterval = null;
let consecutiveEmptyPolls = 0;
let fatalLoginClients = new Set();
let isRunActive = false;

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
    try {
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
    } catch (err) {
        sysLog(`Warning: Failed to sync live queue to DB (${err.message}). Continuing.`);
    }
}

async function syncMasterBacklog() {
    try {
        await queryDB('TRUNCATE TABLE dicev2_master_backlog');
        if (masterBacklog.length === 0) return;

        const chunkSize = 500;
        for (let i = 0; i < masterBacklog.length; i += chunkSize) {
            const chunk = masterBacklog.slice(i, i + chunkSize);
            const values = [];
            const flatParams = [];
            let counter = 1;
            for (const j of chunk) {
                values.push(`($${counter++}, $${counter++}, $${counter++})`);
                flatParams.push(j.applywizz_id, j.email_id, j.url);
            }
            await queryDB(`INSERT INTO dicev2_master_backlog (applywizz_id, email_id, url) VALUES ${values.join(',')}`, flatParams);
        }
    } catch (err) {
        sysLog(`Warning: Failed to sync master backlog to DB (${err.message}). Continuing.`);
    }
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
    const timeout = setTimeout(() => { controller.abort(); }, 60000);
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

async function fetchMessageDetails(email_id, accountId, msg) {
    const folderId = msg.folderId;
    const messageId = msg.messageId;
    
    const messageUrl = `https://zoho-mail-reader.onrender.com/api/zoho/ui/message?email=${encodeURIComponent(email_id)}&accountId=${accountId}&folderId=${folderId}&messageId=${messageId}`;
    const messageRes = await fetch(messageUrl);
    if (!messageRes.ok) throw new Error(`HTTP error fetching message! status: ${messageRes.status}`);
    
    const messageData = await messageRes.json();
    const rawTimeMs = parseInt(messageData.message.receivedTime || msg.receivedTime || '0', 10);
    const readableDate = new Date(rawTimeMs).toLocaleString();

    return {
        from: messageData.message.from || msg.from,
        to: messageData.message.to || msg.to,
        subject: messageData.message.subject || msg.subject,
        receivedTime: readableDate,
        text: extractCleanText(messageData.message.htmlContent || messageData.message.content || '')
    };
}

async function findMatchingZohoEmail(email_id, jobName, company, submissionTimeMs) {
    const targetFrom = 'applyonline@dice.com';
    const normJob = normalizeText(jobName);
    const normComp = normalizeText(company);

    const inboxUrl = `https://zoho-mail-reader.onrender.com/api/zoho/ui/inbox?email=${encodeURIComponent(email_id)}&limit=10&start=1`;
    const inboxRes = await fetch(inboxUrl);
    if (!inboxRes.ok) throw new Error(`HTTP error! status: ${inboxRes.status}`);

    const inboxData = await inboxRes.json();
    const accountId = inboxData.accountId;
    const messages = inboxData.messages || [];

    // Filter by sender and submission timestamp window (with 2 min buffer)
    const bufferMs = 120000;
    const diceMessages = messages.filter(msg => {
        const isFromDice = msg.from && msg.from.includes(targetFrom);
        const receivedMs = parseInt(msg.receivedTime || '0', 10);
        return isFromDice && receivedMs >= (submissionTimeMs - bufferMs);
    });

    for (const msg of diceMessages) {
        const normSubject = normalizeText(msg.subject);

        // Tier 1: Check if Subject contains both Company AND Job Title
        const subjectHasComp = normComp ? normSubject.includes(normComp) : true;
        const subjectHasJob = normJob ? normSubject.includes(normJob) : true;

        if (subjectHasComp && subjectHasJob) {
            return await fetchMessageDetails(email_id, accountId, msg);
        }

        // Tier 2 Fallback: If Subject matches company OR contains "application", inspect Body
        if (subjectHasComp || normSubject.includes('application')) {
            const fullReceipt = await fetchMessageDetails(email_id, accountId, msg);
            if (fullReceipt) {
                const normBody = normalizeText(fullReceipt.text);
                const bodyHasComp = normComp ? normBody.includes(normComp) : true;
                const bodyHasJob = normJob ? normBody.includes(normJob) : true;
                if (bodyHasComp && (bodyHasJob || subjectHasJob)) {
                    return fullReceipt;
                }
            }
        }
    }

    return null;
}

function launchBackgroundZohoPolling(job, submissionTimeMs) {
    const { email_id, applywizz_id, job_name, company, url } = job;
    
    (async () => {
        log(applywizz_id, `[Zoho-BG] Launched detached background polling for ${email_id}...`);
        for (let i = 1; i <= 10; i++) {
            log(applywizz_id, `[Zoho-BG] Attempt ${i}/10 - Checking inbox...`);
            try {
                const receipt = await findMatchingZohoEmail(email_id, job_name, company, submissionTimeMs);
                if (receipt) {
                    log(applywizz_id, `[Zoho-BG] Found matching email on Attempt ${i}! Updating DB.`);
                    await queryDB(`
                        UPDATE dicev2_applied_jobs 
                        SET email_proof = $1, reason = '' 
                        WHERE applywizz_id = $2 AND url = $3
                    `, [JSON.stringify(receipt), applywizz_id, url]);
                    log(applywizz_id, `[Zoho-BG] Success! PostgreSQL updated with email proof.`);
                    return;
                }
            } catch (err) {
                log(applywizz_id, `[Zoho-BG] Error during polling Attempt ${i}: ${err.message}`);
            }

            if (i < 10) await new Promise(r => setTimeout(r, 60000));
        }

        log(applywizz_id, `[Zoho-BG] Timeout reached (10 min). Updating DB.`);
        await queryDB(`
            UPDATE dicev2_applied_jobs 
            SET email_proof = $1, reason = 'zoho skipped' 
            WHERE applywizz_id = $2 AND url = $3
        `, [JSON.stringify({ status: "failed to fetch" }), applywizz_id, url]);
    })().catch(err => {
        log(applywizz_id, `[Zoho-BG] Fatal unhandled error in background task: ${err.message}`);
    });
}

// --- BROWSER AUTOMATION ---
async function runAutomation(job) {
    const { url, applywizz_id, email_id, zoho_connected, job_name, company } = job;
    await updateJobStatus(job, 'PROCESSING');
    log(applywizz_id, `Starting Dice automation for: ${url}`);
    
    let jobStatus = 'Failed';
    let jobReason = 'Unknown error';
    let emailProof = { status: "failed application" };
    let screenshotUrl = null;
    
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
        const emailInput = page.locator('input[name="email"]').first()
            .or(page.locator('input[type="email"]').first())
            .or(page.locator('input[inputmode="email"]').first());
            
        const nextButton = page.locator('button').filter({ hasText: /^Next$/i }).first();
        const submitButton = page.locator('button').filter({ hasText: /^Submit$/i }).first();
        
        const expectedElement = emailInput.or(nextButton).or(submitButton);
        await expectedElement.waitFor({ state: 'visible', timeout: 30000 });

        const isLoginPage = page.url().includes('/login') || await emailInput.isVisible().catch(() => false);

        if (isLoginPage) {
            log(applywizz_id, 'Login page confirmed via URL/DOM. Proceeding with login flow...');
            const password = process.env.DICE_PASSWORD;
            if (!password) throw new Error("DICE_PASSWORD is not set in .env");

            try {
                await emailInput.fill(email_id);
                const continueBtn = page.locator('[data-testid="sign-in-button"]')
                    .or(page.locator('button:has-text("Continue with email")'))
                    .or(page.locator('button[type="submit"]'))
                    .first();
                await continueBtn.click();
                await randomWait(applywizz_id, page, 3000, 6000); 
                
                const passwordInput = page.locator('input[name="password"]').first();
                await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
                await passwordInput.fill(password);
                
                log(applywizz_id, 'Logging in...');
                const submitPassBtn = page.locator('[data-testid="submit-password"]')
                    .or(page.locator('button[type="submit"]'))
                    .first();
                await submitPassBtn.click();
                await randomWait(applywizz_id, page, 5000, 10000); 
                
                const afterLoginElement = nextButton.or(submitButton);
                await afterLoginElement.waitFor({ state: 'visible', timeout: 30000 });
            } catch (err) {
                // Failproof Check: Are we literally still trapped on the login screens?
                const stuckOnEmail = await emailInput.isVisible().catch(() => false);
                const stuckOnPassword = await page.locator('input[name="password"]').isVisible().catch(() => false);
                const stillOnLoginUrl = page.url().includes('/login');
                
                if (stuckOnEmail || stuckOnPassword || stillOnLoginUrl) {
                    throw new Error("Login Failed: Invalid credentials or account blocked.");
                } else {
                    // Login succeeded, but we got intercepted by a random Dice popup or slow network.
                    // We throw a standard error so it only fails THIS job, and doesn't drop the whole client.
                    throw new Error("Login Timeout: Did not reach Next/Submit button after login.");
                }
            }
            
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

        // Navigate back to the original job detail URL in the same page/context
        log(applywizz_id, 'Navigating back to main job page to capture Applied status proof...');
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await randomWait(applywizz_id, page, 5000, 7000); // ~6 seconds wait
        } catch (navErr) {
            log(applywizz_id, `Navigation to job URL encountered notice: ${navErr.message}`);
        }

        // Check for the "Applied" button
        const appliedButton = page.locator('button[data-testid="apply-button"]').filter({ hasText: /Applied/i })
            .or(page.locator('button').filter({ hasText: /Applied/i }))
            .first();

        try {
            log(applywizz_id, 'Checking for "Applied" status button on job page...');
            await appliedButton.waitFor({ state: 'visible', timeout: 12000 });
            log(applywizz_id, 'Confirmed: "Applied" button is visible on job page.');
        } catch (e) {
            log(applywizz_id, 'Notice: "Applied" button wait timed out. Capturing fallback screenshot...');
        }

        log(applywizz_id, 'Taking clean full-page screenshot and sending to AWS S3...');
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
            screenshotUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${encodeURI(objectKey)}`;
            log(applywizz_id, `Screenshot securely uploaded to S3: ${screenshotUrl}`);
        } else {
            log(applywizz_id, `WARNING: S3 missing config. Skipping upload.`);
        }
        
        const submissionTimeMs = Date.now();
        jobStatus = 'Completed';
        
        if (zoho_connected) {
            jobReason = 'awaiting zoho';
            emailProof = { status: "pending receipt" };
            launchBackgroundZohoPolling(job, submissionTimeMs);
        } else {
            jobReason = 'zoho skipped';
            emailProof = { status: "not connected" };
        }
        
    } catch (error) {
        log(applywizz_id, `ERROR: ${error.message}`);
        jobStatus = 'Failed';
        jobReason = error.message;
        emailProof = { status: "failed application" };
        
        if (error.message.includes('Login Failed')) {
            job.fatalLoginError = true;
        }
    } finally {
        await page.close();
        await context.close();
        
        // Write exactly to Azure DB specifications
        try {
            await queryDB(`
                INSERT INTO dicev2_applied_jobs (applywizz_id, url, name, company, status, reason, email_proof, screenshot)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [applywizz_id, url, job_name, company, jobStatus, jobReason, JSON.stringify(emailProof), screenshotUrl]);
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
        } else if (job.fatalLoginError) {
            fatalLoginClients.add(applywizz_id);
            log(applywizz_id, `Fatal Login Error detected! Dropping all remaining jobs for this client to save resources.`);
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

async function ensureBrowserOpen() {
    if (!globalBrowser) {
        sysLog('Launching Chromium browser for active jobs...');
        const isHeadless = process.env.HEADLESS !== 'false';
        globalBrowser = await chromium.launch({ headless: isHeadless });
        isBrowserIdleClosed = false;
        jobsProcessedSinceRestart = 0;
    }
}

async function performBrowserRestart() {
    try {
        if (globalBrowser) {
            sysLog('Closing Chromium to clear Memory/RAM leak...');
            await globalBrowser.close().catch(()=>{});
            globalBrowser = null;
        }
    } catch (e) {
        sysLog(`Error closing browser: ${e.message}`);
    }
    
    sysLog('Relaunching fresh Chromium instance...');
    const isHeadless = process.env.HEADLESS !== 'false';
    globalBrowser = await chromium.launch({ headless: isHeadless });
    
    jobsProcessedSinceRestart = 0;
    isBrowserRestarting = false;
    isBrowserIdleClosed = false;
    
    sysLog('Browser restarted successfully. Resuming queue...');
    checkQueue();
}

async function checkQueue() {
    if (isBrowserRestarting) {
        if (activeWorkers === 0) await performBrowserRestart();
        return;
    }

    if (jobsProcessedSinceRestart >= BROWSER_RESTART_LIMIT) {
        sysLog(`Reached ${BROWSER_RESTART_LIMIT} tabs. Pausing queue to safely restart Chromium and free RAM...`);
        isBrowserRestarting = true;
        if (activeWorkers === 0) await performBrowserRestart();
        return;
    }

    if (activeWorkers >= MAX_WORKERS) return;

    const nextJob = jobQueue.find(j => j.status === 'PENDING' && !activeUsers.has(j.applywizz_id));
    if (!nextJob) return; 

    // Safeguard: Drop job immediately if client already reached 10 completed jobs
    if ((clientSuccessCounts[nextJob.applywizz_id] || 0) >= 10) {
        const idx = jobQueue.indexOf(nextJob);
        if (idx !== -1) jobQueue.splice(idx, 1);
        checkQueue();
        return;
    }

    // Ensure browser is launched if it was idle-closed
    if (!globalBrowser) {
        await ensureBrowserOpen();
    }

    activeUsers.add(nextJob.applywizz_id);
    activeWorkers++;
    jobsProcessedSinceRestart++;
    printDashboard();

    runAutomation(nextJob).finally(() => {});
    checkQueue();
}

function startCooldownEngine() {
    if (cooldownTimer) clearInterval(cooldownTimer);
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
            if (consecutiveEmptyPolls >= 2) {
                await terminateJobRun("No new scraped jobs discovered after 2 consecutive 30-minute background checks.");
            } else {
                if (globalBrowser && !isBrowserIdleClosed) {
                    isBrowserIdleClosed = true;
                    try {
                        await globalBrowser.close();
                    } catch(e) {}
                    globalBrowser = null;
                    sysLog(`[SYSTEM] Queues temporarily empty. Closed Chromium to save RAM while waiting for next 30-min background scraper check (Empty checks: ${consecutiveEmptyPolls}/2)...`);
                }
            }
        }
    }, 10000); 
}

async function terminateJobRun(reason) {
    if (backlogPollerInterval) {
        clearInterval(backlogPollerInterval);
        backlogPollerInterval = null;
    }
    if (cooldownTimer) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
    }
    
    isRunActive = false;
    consecutiveEmptyPolls = 0;
    sysLog(`${reason} Initiating Aggressive RAM Cleanup.`);
    
    if (globalBrowser) {
        await globalBrowser.close().catch(() => {});
        globalBrowser = null; 
    }
    isBrowserIdleClosed = false;
    
    activeUsers.clear();
    clientSuccessCounts = {};
    fatalLoginClients.clear();
    jobsProcessedSinceRestart = 0;
    isBrowserRestarting = false;
    
    await queryDB('TRUNCATE TABLE trigger_client').catch(() => {});
    
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
}

async function pollAndIngestNewJobs() {
    if (!isRunActive) return;
    try {
        sysLog('[POLLER] Running 30-minute background check for newly scraped jobs...');

        const freshJobs = await queryDB(`
            SELECT d.url, d.applywizz_id, d.title as job_name, d.company, c.company_email as email_id
            FROM dice_scraped_jobs d
            JOIN clients_additional_info c ON d.applywizz_id = c.applywizz_id
            WHERE d.scraped_at > NOW() - INTERVAL '12 hours'
              AND NOT EXISTS (
                  SELECT 1 FROM dicev2_applied_jobs a 
                  WHERE a.url = d.url AND a.applywizz_id = d.applywizz_id
              );
        `);

        const existingUrls = new Set([
            ...jobQueue.map(j => j.url),
            ...masterBacklog.map(j => j.url)
        ]);

        const todayCountsMap = await getTodayCompletedCountsMap();
        for (const [uid, count] of todayCountsMap.entries()) {
            clientSuccessCounts[uid] = Math.max(clientSuccessCounts[uid] || 0, count);
        }

        const newJobs = [];
        for (const row of freshJobs) {
            if (existingUrls.has(row.url)) continue;
            if ((clientSuccessCounts[row.applywizz_id] || 0) >= 10) continue;
            if (fatalLoginClients.has(row.applywizz_id)) continue;
            
            existingUrls.add(row.url);
            newJobs.push(row);
        }

        if (newJobs.length === 0) {
            sysLog('[POLLER] No new matching scraped jobs found during check.');
            if (jobQueue.length === 0 && masterBacklog.length === 0 && activeWorkers === 0) {
                consecutiveEmptyPolls++;
                sysLog(`[POLLER] Queues are empty. Consecutive empty checks: ${consecutiveEmptyPolls}/2.`);
                if (consecutiveEmptyPolls >= 2) {
                    await terminateJobRun("No new scraped jobs discovered after 2 consecutive 30-minute background checks.");
                }
            }
            return;
        }

        consecutiveEmptyPolls = 0;
        const uniqueNewClients = [...new Set(newJobs.map(j => j.applywizz_id))];
        sysLog(`[POLLER] Discovered ${newJobs.length} new scraped jobs across ${uniqueNewClients.length} clients.`);

        const clientsToPrecheck = newJobs.map(r => ({ email_id: r.email_id, applywizz_id: r.applywizz_id }));
        const precheckedClients = await precheckZohoConnections(clientsToPrecheck);

        let maxId = Math.max(
            0,
            ...jobQueue.map(j => j.id || 0),
            ...masterBacklog.map(j => j.id || 0)
        );

        for (const row of newJobs) {
            const client = precheckedClients.find(c => c.applywizz_id === row.applywizz_id);
            masterBacklog.push({
                id: ++maxId,
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

        // Promote 1 job into jobQueue for any eligible client who currently has NO job in jobQueue
        let promotedCount = 0;
        const clientsInQueue = new Set(jobQueue.map(j => j.applywizz_id));
        const uniqueBacklogUsers = [...new Set(masterBacklog.map(j => j.applywizz_id))];

        for (const uid of uniqueBacklogUsers) {
            if ((clientSuccessCounts[uid] || 0) >= 10) continue;
            if (fatalLoginClients.has(uid)) continue;
            if (clientsInQueue.has(uid)) continue;

            const nextIdx = masterBacklog.findIndex(j => j.applywizz_id === uid);
            if (nextIdx !== -1) {
                const job = masterBacklog.splice(nextIdx, 1)[0];
                jobQueue.push(job);
                clientsInQueue.add(uid);
                promotedCount++;
            }
        }

        if (promotedCount > 0) {
            sysLog(`[POLLER] Promoted ${promotedCount} jobs directly to live queue for idle clients.`);
        }

        await syncMasterBacklog();
        await syncLiveQueue();

        if (jobQueue.some(j => j.status === 'PENDING')) {
            await ensureBrowserOpen();
            checkQueue();
        }
    } catch (err) {
        sysLog(`[POLLER ERROR] Error during background backlog polling: ${err.message}`);
    }
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
            email_proof JSONB,
            screenshot TEXT
        );
        ALTER TABLE dicev2_applied_jobs ADD COLUMN IF NOT EXISTS screenshot TEXT;
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
        CREATE TABLE IF NOT EXISTS trigger_client (
            applywizz_id VARCHAR PRIMARY KEY,
            status VARCHAR,
            triggered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
    `);
}

let clientSuccessCounts = {};

async function getTodayClientCompletedCount(applywizz_id) {
    try {
        const res = await queryDB(`
            SELECT COUNT(*) as count 
            FROM dicev2_applied_jobs 
            WHERE applywizz_id = $1 
              AND status = 'Completed' 
              AND (time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        `, [applywizz_id]);
        return parseInt(res[0]?.count || 0, 10);
    } catch (e) {
        return 0;
    }
}

async function getTodayCompletedCountsMap() {
    try {
        const rows = await queryDB(`
            SELECT applywizz_id, COUNT(*) as count 
            FROM dicev2_applied_jobs 
            WHERE status = 'Completed' 
              AND (time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            GROUP BY applywizz_id
        `);
        const map = new Map();
        for (const r of rows) {
            map.set(r.applywizz_id, parseInt(r.count, 10));
        }
        return map;
    } catch (e) {
        sysLog(`Warning: Failed to fetch today completed counts map: ${e.message}`);
        return new Map();
    }
}

async function startJobRun(isFresh = true) {
    const isAlreadyRunning = isRunActive || jobQueue.length > 0 || masterBacklog.length > 0;

    if (isAlreadyRunning) {
        sysLog('=== SCHEDULED CRON FIRED (MERGE MODE) ===');
        sysLog('Automation is currently active with early triggered clients. Merging remaining clients...');

        // Fetch remaining clients not yet triggered via trigger_client
        const rawJobs = await queryDB(`
            SELECT d.url, d.applywizz_id, d.title as job_name, d.company, c.company_email as email_id
            FROM dice_scraped_jobs d
            JOIN clients_additional_info c ON d.applywizz_id = c.applywizz_id
            WHERE d.applywizz_id NOT IN (SELECT applywizz_id FROM trigger_client)
              AND d.scraped_at > NOW() - INTERVAL '24 hours'
              AND NOT EXISTS (
                  SELECT 1 FROM dicev2_applied_jobs a 
                  WHERE a.url = d.url AND a.applywizz_id = d.applywizz_id
              );
        `);

        if (rawJobs.length === 0) {
            sysLog('[MERGE] No remaining clients or fresh jobs to merge. Continuing with current active queues.');
            return;
        }

        // Deduplicate against active memory
        const existingUrls = new Set([...jobQueue.map(j => j.url), ...masterBacklog.map(j => j.url)]);
        const newJobs = rawJobs.filter(j => !existingUrls.has(j.url));

        if (newJobs.length === 0) {
            sysLog('[MERGE] All remaining jobs are already in memory. Continuing.');
            return;
        }

        const clientsToPrecheck = newJobs.map(r => ({ email_id: r.email_id, applywizz_id: r.applywizz_id }));
        const precheckedClients = await precheckZohoConnections(clientsToPrecheck);
        const todayCountsMap = await getTodayCompletedCountsMap();
        for (const [uid, count] of todayCountsMap.entries()) {
            clientSuccessCounts[uid] = Math.max(clientSuccessCounts[uid] || 0, count);
        }

        let maxId = Math.max(0, ...jobQueue.map(j => j.id || 0), ...masterBacklog.map(j => j.id || 0));
        for (const row of newJobs) {
            const todayCount = todayCountsMap.get(row.applywizz_id) || 0;
            if (todayCount >= 10) continue;

            const client = precheckedClients.find(c => c.applywizz_id === row.applywizz_id);
            masterBacklog.push({
                id: ++maxId,
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

        // Promote exactly 1 job per remaining client who has 0 jobs in jobQueue
        const uniqueRemainingUsers = [...new Set(newJobs.map(j => j.applywizz_id))];
        for (const uid of uniqueRemainingUsers) {
            const hasInQueue = jobQueue.some(j => j.applywizz_id === uid);
            if (!hasInQueue) {
                const nextIdx = masterBacklog.findIndex(j => j.applywizz_id === uid);
                if (nextIdx !== -1) {
                    jobQueue.push(masterBacklog.splice(nextIdx, 1)[0]);
                }
            }
        }

        await syncMasterBacklog();
        await syncLiveQueue();

        if (!globalBrowser) {
            sysLog('[MERGE] Launching Chromium browser for merged clients...');
            const isHeadless = process.env.HEADLESS !== 'false';
            globalBrowser = await chromium.launch({ headless: isHeadless });
        }

        checkQueue();
        sysLog(`[MERGE] Merged ${newJobs.length} fresh jobs for remaining clients. Active queue size: ${jobQueue.length}, Backlog: ${masterBacklog.length}`);
        return;
    }

    sysLog('=== STARTING SCHEDULED JOB RUN (FRESH MODE) ===');
    isRunActive = true;
    consecutiveEmptyPolls = 0;
    fatalLoginClients.clear();
    isBrowserIdleClosed = false;

    // Start 30-minute background backlog scraper poller
    if (backlogPollerInterval) clearInterval(backlogPollerInterval);
    backlogPollerInterval = setInterval(pollAndIngestNewJobs, 30 * 60 * 1000);
    sysLog('Started 30-minute background backlog scraper poller.');

    if (!process.env.DATABASE_URL) {
        sysLog('CRITICAL ERROR: DATABASE_URL not set in .env');
        return;
    }

    await initializeDatabase();
    await queryDB('TRUNCATE TABLE dicev2_live_queue, dicev2_master_backlog');

    // 1. Fetch valid jobs < 24 hours old
    const rawJobs = await queryDB(`
        SELECT d.url, d.applywizz_id, d.title as job_name, d.company, c.company_email as email_id
        FROM dice_scraped_jobs d
        JOIN clients_additional_info c ON d.applywizz_id = c.applywizz_id
        WHERE d.scraped_at > NOW() - INTERVAL '24 hours'
          AND NOT EXISTS (
              SELECT 1 FROM dicev2_applied_jobs a 
              WHERE a.url = d.url AND a.applywizz_id = d.applywizz_id
          );
    `);
    
    if (rawJobs.length === 0) {
        sysLog('No valid fresh jobs found in DB initially. Standing by with 30-minute background scraper poller active.');
        startCooldownEngine();
        return;
    }

    sysLog(`Fetched ${rawJobs.length} fresh jobs from DB.`);

    // 2. Zoho Precheck
    const clientsToPrecheck = rawJobs.map(r => ({ email_id: r.email_id, applywizz_id: r.applywizz_id }));
    const precheckedClients = await precheckZohoConnections(clientsToPrecheck);
    
    // Batch query today completed counts for all clients in 1 single query
    const todayCountsMap = await getTodayCompletedCountsMap();
    for (const [uid, count] of todayCountsMap.entries()) {
        clientSuccessCounts[uid] = Math.max(clientSuccessCounts[uid] || 0, count);
    }
    sysLog(`Fetched today completed counts for ${todayCountsMap.size} clients in 1 batch query.`);

    let jobIdCounter = 1;
    for (const row of rawJobs) {
        const todayCount = todayCountsMap.get(row.applywizz_id) || 0;
        if (todayCount >= 10) continue;

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
    const isHeadless = process.env.HEADLESS !== 'false';
    globalBrowser = await chromium.launch({ headless: isHeadless });
    
    sysLog('Starting Queue Manager...');
    checkQueue();
}

async function pollClientStatusApi() {
    const apiUrl = process.env.CLIENT_STATUS_API_URL;
    if (!apiUrl) return;

    try {
        const now = new Date();
        // Calculate current IST minutes from midnight (UTC + 5 hours 30 mins)
        const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
        
        // 10:00 AM IST = 10 * 60 = 600 minutes
        // Only poll between 10:00 AM IST and 11:58 PM IST (or when run is active)
        if (istMinutes < 600 && !isRunActive) {
            return;
        }

        sysLog(`[STATUS-POLLER] Checking client status API: ${apiUrl}...`);
        const response = await fetch(apiUrl);
        if (!response.ok) {
            sysLog(`[STATUS-POLLER] API returned HTTP ${response.status}`);
            return;
        }

        const data = await response.json();
        const clientList = data.clients || (Array.isArray(data) ? data : []);
        if (!Array.isArray(clientList) || clientList.length === 0) return;

        const completedClients = clientList.filter(item => 
            item.applywizz_id && 
            item.status && 
            item.status.trim().toLowerCase() === 'completed'
        );

        if (completedClients.length === 0) return;

        const existingRecords = await queryDB('SELECT applywizz_id FROM trigger_client');
        const triggeredSet = new Set(existingRecords.map(r => r.applywizz_id));

        const newlyCompleted = completedClients.filter(c => !triggeredSet.has(c.applywizz_id));
        if (newlyCompleted.length === 0) return;

        sysLog(`[STATUS-POLLER] Found ${newlyCompleted.length} new completed client(s): ${newlyCompleted.map(c=>c.applywizz_id).join(', ')}`);

        let newlyAddedJobsCount = 0;
        for (const clientItem of newlyCompleted) {
            const uid = clientItem.applywizz_id;
            const todayCount = await getTodayClientCompletedCount(uid);
            clientSuccessCounts[uid] = Math.max(clientSuccessCounts[uid] || 0, todayCount);

            if (todayCount >= 10) {
                sysLog(`[STATUS-POLLER] Client ${uid} already completed ${todayCount} jobs today (cap reached). Skipping.`);
                await queryDB('INSERT INTO trigger_client (applywizz_id, status) VALUES ($1, $2) ON CONFLICT (applywizz_id) DO NOTHING', [uid, 'capped']);
                continue;
            }

            await queryDB('INSERT INTO trigger_client (applywizz_id, status) VALUES ($1, $2) ON CONFLICT (applywizz_id) DO UPDATE SET status = EXCLUDED.status', [uid, clientItem.status]);

            const jobs = await queryDB(`
                SELECT d.url, d.applywizz_id, d.title as job_name, d.company, c.company_email as email_id
                FROM dice_scraped_jobs d
                JOIN clients_additional_info c ON d.applywizz_id = c.applywizz_id
                WHERE d.applywizz_id = $1
                  AND d.scraped_at > NOW() - INTERVAL '24 hours'
                  AND NOT EXISTS (
                      SELECT 1 FROM dicev2_applied_jobs a 
                      WHERE a.url = d.url AND a.applywizz_id = d.applywizz_id
                  );
            `, [uid]);

            if (jobs.length === 0) continue;

            const existingUrls = new Set([...jobQueue.map(j => j.url), ...masterBacklog.map(j => j.url)]);
            const freshJobs = jobs.filter(j => !existingUrls.has(j.url));
            if (freshJobs.length === 0) continue;

            // Only queue up to remaining quota for today
            const remainingQuota = 10 - todayCount;
            const jobsToQueue = freshJobs.slice(0, remainingQuota);

            const prechecked = await precheckZohoConnections([{ email_id: jobsToQueue[0].email_id, applywizz_id: uid }]);
            const zohoConn = prechecked[0]?.zoho_connected || false;

            let maxId = Math.max(0, ...jobQueue.map(j => j.id || 0), ...masterBacklog.map(j => j.id || 0));
            for (const j of jobsToQueue) {
                masterBacklog.push({
                    id: ++maxId,
                    applywizz_id: uid,
                    email_id: j.email_id,
                    zoho_connected: zohoConn,
                    url: j.url,
                    job_name: j.job_name,
                    company: j.company,
                    status: 'PENDING',
                    cooldown_until: '',
                    cooldown_until_ms: 0
                });
            }

            const hasInQueue = jobQueue.some(j => j.applywizz_id === uid);
            if (!hasInQueue) {
                const nextIdx = masterBacklog.findIndex(j => j.applywizz_id === uid);
                if (nextIdx !== -1) {
                    jobQueue.push(masterBacklog.splice(nextIdx, 1)[0]);
                }
            }

            newlyAddedJobsCount += jobsToQueue.length;
        }

        if (newlyAddedJobsCount > 0) {
            await syncMasterBacklog();
            await syncLiveQueue();

            isRunActive = true;
            isBrowserIdleClosed = false;
            consecutiveEmptyPolls = 0;

            if (!globalBrowser) {
                sysLog('[STATUS-POLLER] Launching Chromium browser for triggered clients...');
                const isHeadless = process.env.HEADLESS !== 'false';
                globalBrowser = await chromium.launch({ headless: isHeadless });
            }

            if (!cooldownTimer) startCooldownEngine();
            if (!backlogPollerInterval) backlogPollerInterval = setInterval(pollAndIngestNewJobs, 30 * 60 * 1000);

            checkQueue();
            sysLog(`[STATUS-POLLER] Successfully queued ${newlyAddedJobsCount} jobs. Active queue size: ${jobQueue.length}, Backlog: ${masterBacklog.length}`);
        }
    } catch (err) {
        sysLog(`[STATUS-POLLER] Error: ${err.message}`);
    }
}

// --- EXPRESS DASHBOARD SERVER ---
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        const expectedUser = process.env.DASHBOARD_USERNAME || 'admin';
        const expectedPass = process.env.DASHBOARD_PASSWORD || 'applywizz2026';

        if (username === expectedUser && password === expectedPass) {
            return res.json({ success: true, token: 'applywizz-session-token' });
        }
        return res.status(401).json({ error: 'Invalid username or password' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const TZ_MAP = {
    IST: 'Asia/Kolkata',
    UTC: 'UTC',
    EST: 'America/New_York',
    CST: 'America/Chicago',
    PST: 'America/Los_Angeles'
};

function getTimeFilter(from, to, tzKey, startIdx = 1) {
    if (!from || !to) return { clause: "", params: [] };
    const tzName = TZ_MAP[tzKey] || 'Asia/Kolkata';
    return {
        clause: `(time AT TIME ZONE 'UTC' AT TIME ZONE $${startIdx}) >= $${startIdx + 1}::timestamp AND (time AT TIME ZONE 'UTC' AT TIME ZONE $${startIdx}) <= $${startIdx + 2}::timestamp`,
        params: [tzName, from, to]
    };
}

app.get('/api/stats', async (req, res) => {
    try {
        const { from, to, tz = 'IST' } = req.query;
        let timeFilter = "";
        let params = [];
        if (from && to) {
            const filter = getTimeFilter(from, to, tz, 1);
            timeFilter = `WHERE ${filter.clause}`;
            params = filter.params;
        }
        
        // 1. Distinct active clients directly from clients_additional_info
        let activeClientsCount = 0;
        try {
            const activeRes = await queryDB("SELECT COUNT(DISTINCT applywizz_id) as count FROM clients_additional_info WHERE applywizz_id IS NOT NULL");
            activeClientsCount = parseInt(activeRes[0]?.count || 0, 10);
        } catch(e) {
            console.error("Error fetching active clients count:", e.message);
        }

        // 2. Client list joined with counts in the date filter
        const clientsRes = await queryDB(`
            WITH client_jobs AS (
                SELECT 
                    applywizz_id, 
                    SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) as completed_count,
                    SUM(CASE WHEN status = 'Completed' AND (reason ILIKE '%zoho%' OR (reason IS NOT NULL AND reason != '')) THEN 1 ELSE 0 END) as zoho_skipped_count,
                    SUM(CASE WHEN status = 'Completed' AND (reason IS NULL OR reason = '') THEN 1 ELSE 0 END) as clean_completed_count,
                    SUM(CASE WHEN status = 'Failed' AND (reason ILIKE '%no_apply_button%' OR reason ILIKE '%no apply button%') THEN 1 ELSE 0 END) as preflight_failed_count,
                    SUM(CASE WHEN status = 'Failed' AND (reason NOT ILIKE '%no_apply_button%' AND reason NOT ILIKE '%no apply button%' OR reason IS NULL) THEN 1 ELSE 0 END) as failed_count
                FROM dicev2_applied_jobs
                ${timeFilter}
                GROUP BY applywizz_id
            )
            SELECT 
                COALESCE(c.applywizz_id, j.applywizz_id) as applywizz_id,
                COALESCE(c.company_email, '') as company_email,
                COALESCE(j.completed_count, 0) as completed_count,
                COALESCE(j.zoho_skipped_count, 0) as zoho_skipped_count,
                COALESCE(j.clean_completed_count, 0) as clean_completed_count,
                COALESCE(j.preflight_failed_count, 0) as preflight_failed_count,
                COALESCE(j.failed_count, 0) as failed_count
            FROM clients_additional_info c
            FULL OUTER JOIN client_jobs j ON c.applywizz_id = j.applywizz_id
            WHERE COALESCE(c.applywizz_id, j.applywizz_id) IS NOT NULL
            ORDER BY completed_count DESC, failed_count DESC, applywizz_id ASC
        `, params);

        // 3. Overall Totals
        const totalRes = await queryDB(`
            SELECT 
                COALESCE(COUNT(DISTINCT CASE WHEN status = 'Completed' THEN applywizz_id END), 0) as clients_with_completed,
                COALESCE(SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END), 0) as total_completed,
                COALESCE(SUM(CASE WHEN status = 'Completed' AND (reason ILIKE '%zoho%' OR (reason IS NOT NULL AND reason != '')) THEN 1 ELSE 0 END), 0) as completed_zoho_skipped,
                COALESCE(SUM(CASE WHEN status = 'Completed' AND (reason IS NULL OR reason = '') THEN 1 ELSE 0 END), 0) as properly_completed,
                COALESCE(SUM(CASE WHEN status = 'Failed' AND (reason ILIKE '%no_apply_button%' OR reason ILIKE '%no apply button%') THEN 1 ELSE 0 END), 0) as total_preflight_failed,
                COALESCE(SUM(CASE WHEN status = 'Failed' AND (reason NOT ILIKE '%no_apply_button%' AND reason NOT ILIKE '%no apply button%' OR reason IS NULL) THEN 1 ELSE 0 END), 0) as total_failed
            FROM dicev2_applied_jobs
            ${timeFilter}
        `, params);

        const totalsRow = totalRes[0] || {};

        res.json({
            totals: {
                active_clients: activeClientsCount,
                clients_with_completed: parseInt(totalsRow.clients_with_completed || 0, 10),
                total_completed: parseInt(totalsRow.total_completed || 0, 10),
                completed_zoho_skipped: parseInt(totalsRow.completed_zoho_skipped || 0, 10),
                properly_completed: parseInt(totalsRow.properly_completed || 0, 10),
                total_preflight_failed: parseInt(totalsRow.total_preflight_failed || 0, 10),
                total_failed: parseInt(totalsRow.total_failed || 0, 10)
            },
            clients: clientsRes
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/errors', async (req, res) => {
    try {
        const { from, to, tz = 'IST' } = req.query;
        let timeFilter = "WHERE status = 'Failed'";
        const params = [];
        if (from && to) {
            const filter = getTimeFilter(from, to, tz, 1);
            timeFilter += ` AND ${filter.clause}`;
            params.push(...filter.params);
        }
        const errors = await queryDB(`
            SELECT applywizz_id, name, company, url, reason, time 
            FROM dicev2_applied_jobs
            ${timeFilter}
            ORDER BY time DESC
            LIMIT 500
        `, params);
        res.json(errors);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Purge the entire Master Backlog and Job Queue from RAM instantly
app.post('/api/purge-queue', async (req, res) => {
    try {
        const deletedCount = masterBacklog.length + jobQueue.length;
        masterBacklog.length = 0;
        jobQueue.length = 0;
        if (backlogPollerInterval) {
            clearInterval(backlogPollerInterval);
            backlogPollerInterval = null;
        }
        isRunActive = false;
        sysLog(`Queue manually purged via Dashboard API. Cleared ${deletedCount} items from memory.`);
        res.json({ message: 'Queue Purged Successfully', cleared: deletedCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Purge single client's backlog and live queue from RAM and DB
app.post('/api/purge-client', async (req, res) => {
    try {
        const { applywizz_id } = req.body || {};
        if (!applywizz_id) {
            return res.status(400).json({ error: 'applywizz_id is required' });
        }

        let clearedRamBacklog = 0;
        let clearedRamQueue = 0;

        // 1. Purge from RAM masterBacklog
        for (let i = masterBacklog.length - 1; i >= 0; i--) {
            if (masterBacklog[i].applywizz_id === applywizz_id) {
                masterBacklog.splice(i, 1);
                clearedRamBacklog++;
            }
        }

        // 2. Purge from RAM jobQueue (only PENDING or COOLDOWN, leave PROCESSING to finish gracefully)
        for (let i = jobQueue.length - 1; i >= 0; i--) {
            if (jobQueue[i].applywizz_id === applywizz_id) {
                if (jobQueue[i].status !== 'PROCESSING') {
                    jobQueue.splice(i, 1);
                    clearedRamQueue++;
                }
            }
        }

        // 3. Purge from PostgreSQL Database tables
        await queryDB('DELETE FROM dicev2_master_backlog WHERE applywizz_id = $1', [applywizz_id]);
        await queryDB("DELETE FROM dicev2_live_queue WHERE applywizz_id = $1 AND status != 'PROCESSING'", [applywizz_id]);

        // 4. Synchronize DB tables with RAM state
        await syncLiveQueue();
        await syncMasterBacklog();

        const totalCleared = clearedRamBacklog + clearedRamQueue;
        sysLog(`Purged client [${applywizz_id}] from active run queues. Cleared ${clearedRamBacklog} backlog & ${clearedRamQueue} queued jobs.`);

        res.json({
            success: true,
            applywizz_id,
            cleared_backlog: clearedRamBacklog,
            cleared_queue: clearedRamQueue,
            total_cleared: totalCleared,
            message: `Successfully purged ${totalCleared} jobs for ${applywizz_id}`
        });
    } catch (err) {
        sysLog(`ERROR purging client [${req.body?.applywizz_id}]: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Run single client on-demand (loads unapplied scraped jobs into masterBacklog and triggers worker)
app.post('/api/run-client', async (req, res) => {
    try {
        const { applywizz_id, extend_cap } = req.body || {};
        if (!applywizz_id) {
            return res.status(400).json({ error: 'applywizz_id is required' });
        }

        const todayCount = await getTodayClientCompletedCount(applywizz_id);
        clientSuccessCounts[applywizz_id] = Math.max(clientSuccessCounts[applywizz_id] || 0, todayCount);
        if (todayCount >= 10 && !extend_cap) {
            return res.status(400).json({ 
                error: `Client ${applywizz_id} has already reached 10 completed applications today.`,
                requires_confirmation: true,
                completed_count: todayCount
            });
        }

        // Record in trigger_client
        await queryDB('INSERT INTO trigger_client (applywizz_id, status) VALUES ($1, $2) ON CONFLICT (applywizz_id) DO UPDATE SET status = EXCLUDED.status', [applywizz_id, 'manual_run']);

        // Ingest unapplied scraped jobs from dice_scraped_jobs (last 24 hours)
        const jobs = await queryDB(`
            SELECT d.url, d.applywizz_id, d.title as job_name, d.company, c.company_email as email_id
            FROM dice_scraped_jobs d
            JOIN clients_additional_info c ON d.applywizz_id = c.applywizz_id
            WHERE d.applywizz_id = $1
              AND d.scraped_at > NOW() - INTERVAL '24 hours'
              AND NOT EXISTS (
                  SELECT 1 FROM dicev2_applied_jobs a 
                  WHERE a.url = d.url AND a.applywizz_id = d.applywizz_id
              );
        `, [applywizz_id]);

        if (jobs.length === 0) {
            return res.json({ 
                success: true, 
                count: 0, 
                message: `No new unapplied scraped jobs found in the last 24 hours for ${applywizz_id}.` 
            });
        }

        // Deduplicate against active queues
        const existingUrls = new Set([...jobQueue.map(j => j.url), ...masterBacklog.map(j => j.url)]);
        const unqueuedJobs = jobs.filter(j => !existingUrls.has(j.url));
        const remainingQuota = extend_cap ? unqueuedJobs.length : Math.max(1, 10 - todayCount);
        const freshJobs = unqueuedJobs.slice(0, remainingQuota);

        if (freshJobs.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: `All ${jobs.length} jobs are already queued in the active backlog.`
            });
        }

        // Zoho connection precheck
        const prechecked = await precheckZohoConnections([{ email_id: freshJobs[0].email_id, applywizz_id }]);
        const zohoConn = prechecked[0]?.zoho_connected || false;

        let maxId = Math.max(0, ...jobQueue.map(j => j.id || 0), ...masterBacklog.map(j => j.id || 0));
        for (const j of freshJobs) {
            masterBacklog.push({
                id: ++maxId,
                applywizz_id,
                email_id: j.email_id,
                zoho_connected: zohoConn,
                url: j.url,
                job_name: j.job_name,
                company: j.company,
                status: 'PENDING',
                cooldown_until: '',
                cooldown_until_ms: 0
            });
        }

        // Promote 1 job to live queue if client currently has none
        const hasInQueue = jobQueue.some(j => j.applywizz_id === applywizz_id);
        if (!hasInQueue) {
            const nextIdx = masterBacklog.findIndex(j => j.applywizz_id === applywizz_id);
            if (nextIdx !== -1) {
                jobQueue.push(masterBacklog.splice(nextIdx, 1)[0]);
            }
        }

        await syncMasterBacklog();
        await syncLiveQueue();

        // Wake up automation engine if idle
        isRunActive = true;
        isBrowserIdleClosed = false;
        consecutiveEmptyPolls = 0;

        if (!globalBrowser) {
            sysLog(`[MANUAL-RUN] Launching Chromium browser for client ${applywizz_id}...`);
            const isHeadless = process.env.HEADLESS !== 'false';
            globalBrowser = await chromium.launch({ headless: isHeadless });
        }

        if (!cooldownTimer) startCooldownEngine();
        if (!backlogPollerInterval) backlogPollerInterval = setInterval(pollAndIngestNewJobs, 30 * 60 * 1000);

        checkQueue();

        res.json({
            success: true,
            applywizz_id,
            count: freshJobs.length,
            message: `Successfully loaded ${freshJobs.length} jobs into queue for ${applywizz_id}!`
        });
    } catch (err) {
        sysLog(`ERROR in /api/run-client: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/jobs/:applywizz_id', async (req, res) => {
    try {
        const { applywizz_id } = req.params;
        const { from, to, tz = 'IST' } = req.query;
        let timeFilter = "";
        const params = [applywizz_id];
        if (from && to) {
            const filter = getTimeFilter(from, to, tz, 2);
            timeFilter = `AND ${filter.clause}`;
            params.push(...filter.params);
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

// Secure endpoint to stream S3 screenshot
app.get('/api/screenshot/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const jobs = await queryDB('SELECT screenshot, applywizz_id, company, name FROM dicev2_applied_jobs WHERE id = $1', [id]);
        if (jobs.length === 0 || !jobs[0].screenshot) {
            return res.status(404).send('Screenshot not found');
        }

        const s3Prefix = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/`;
        let key = jobs[0].screenshot;
        if (key.startsWith(s3Prefix)) {
            key = decodeURI(key.slice(s3Prefix.length));
        }

        if (!s3 || !process.env.AWS_BUCKET_NAME) {
            return res.status(500).send('S3 client not configured');
        }

        const s3Res = await s3.send(new GetObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key
        }));

        res.setHeader('Content-Type', s3Res.ContentType || 'image/png');
        if (s3Res.ContentLength) res.setHeader('Content-Length', s3Res.ContentLength);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        s3Res.Body.pipe(res);
    } catch (err) {
        res.status(500).send(`Error loading screenshot: ${err.message}`);
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

function parseArrayIfNeeded(key, val) {
    if (typeof val === 'string') {
        if (val.startsWith('[') && val.endsWith(']')) {
            try { return JSON.parse(val); } catch(e) {}
        }
        // Explicitly wrap known array fields if they come as raw strings (e.g. "NA" instead of ["NA"])
        const arrayFields = ['exclude_companies', 'job_role_preferences', 'location_preferences', 'add_ons_info'];
        if (arrayFields.includes(key)) {
            return [val];
        }
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
        
        mapped[key] = parseArrayIfNeeded(k, v);
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
        
        mapped[key] = parseArrayIfNeeded(k, v);
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

// Start 15-minute background client status API poller
setInterval(pollClientStatusApi, 15 * 60 * 1000);
sysLog('Started 15-minute background client status API poller.');
pollClientStatusApi().catch(e => sysLog(`Initial Status Poll Error: ${e.message}`));
// Schedule Daily Hard Stop at 11:59 PM IST (Asia/Kolkata)
cron.schedule('59 23 * * *', async () => {
    sysLog('=== DAILY HARD CUTOFF: 11:59 PM IST REACHED ===');
    sysLog('Terminating active automation, closing browser, and clearing queues for the night.');
    jobQueue = [];
    masterBacklog = [];
    await syncLiveQueue();
    await syncMasterBacklog();
    await terminateJobRun('Daily 11:59 PM IST Hard Stop.');
}, {
    timezone: 'Asia/Kolkata'
});
sysLog('Scheduled Daily Hard Stop at 11:59 PM IST.');

if (process.env.CRON_SCHEDULE) {
    sysLog(`Starting Railway Node-Cron Scheduler: ${process.env.CRON_SCHEDULE}`);
    cron.schedule(process.env.CRON_SCHEDULE, () => {
        startJobRun(true).catch(err => sysLog(`CRON ERROR: ${err.message}`));
    });

    // Auto-resume today's run if container restarted within 4 hours after scheduled cron time
    setTimeout(() => {
        try {
            const parts = process.env.CRON_SCHEDULE.trim().split(/\s+/);
            if (parts.length >= 2) {
                const cronMinute = parseInt(parts[0], 10);
                const cronHour = parseInt(parts[1], 10);
                const now = new Date();
                const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
                const cronMinutes = cronHour * 60 + cronMinute;

                if (nowMinutes >= cronMinutes && nowMinutes <= (cronMinutes + 240) && !isRunActive) {
                    sysLog(`[BOOT] Server restarted within scheduled run window (${cronHour}:${cronMinute} UTC). Auto-starting today's run...`);
                    startJobRun(true).catch(err => sysLog(`AUTO-START ERROR: ${err.message}`));
                }
            }
        } catch (e) {
            sysLog(`Auto-start check notice: ${e.message}`);
        }
    }, 5000);
} else {
    sysLog('No CRON_SCHEDULE provided. Running immediately for testing.');
    startJobRun(true).catch(err => sysLog(`RUN ERROR: ${err.message}`));
}
