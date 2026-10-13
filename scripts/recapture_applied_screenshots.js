const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { chromium } = require('playwright');
const { Client } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// --- CLI ARGUMENT PARSING ---
const args = process.argv.slice(2);
const isTestMode = args.includes('--test');
const forceRecheck = args.includes('--force');
const clientFilterArg = args.find(a => a.startsWith('--client='));
const targetClientId = clientFilterArg ? clientFilterArg.split('=')[1] : null;
const limitArg = args.find(a => a.startsWith('--limit='));
const jobLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : (isTestMode ? 3 : Infinity);
const isHeadless = !args.includes('--headed');

// --- DIRECTORIES & CHECKPOINTING ---
const scratchDir = path.join(__dirname, '../scratch');
if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
}
const sessionsDir = path.join(__dirname, '../sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}
const progressFile = path.join(scratchDir, 'recapture_progress.json');

let progress = {
    completedJobIds: [],
    skippedJobIds: [],
    failedClientIds: []
};

if (fs.existsSync(progressFile) && !forceRecheck) {
    try {
        progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        console.log(`[CHECKPOINT] Loaded existing progress: ${progress.completedJobIds.length} completed, ${progress.skippedJobIds.length} skipped.`);
    } catch (e) {
        console.warn('[CHECKPOINT] Could not parse progress file. Starting fresh.');
    }
}

function saveProgress() {
    fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
}

// --- AWS S3 CLIENT ---
let s3;
if (process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    s3 = new S3Client({
        region: process.env.AWS_REGION,
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
    });
} else {
    console.error('ERROR: AWS credentials missing in .env!');
    process.exit(1);
}

const s3Bucket = process.env.AWS_BUCKET_NAME || 'applywizz-prod-v2';
const s3BasePath = process.env.AWS_S3_BASE_PATH || 'dice-applications/screenshots';

// --- UTILITIES ---
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function log(clientId, msg) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] [${clientId || 'SYSTEM'}] ${msg}`);
}

function getS3KeyFromUrl(screenshotUrl, applywizz_id, company, job_name) {
    if (screenshotUrl && screenshotUrl.startsWith('http')) {
        try {
            const urlObj = new URL(screenshotUrl);
            return decodeURIComponent(urlObj.pathname.replace(/^\//, ''));
        } catch (e) {}
    }
    const safeCompany = company ? company.replace(/[/\\?%*:|"<>\x00-\x1F]/g, '-') : 'UnknownCompany';
    const safeJobName = job_name ? job_name.replace(/[/\\?%*:|"<>\x00-\x1F]/g, '-') : 'UnknownJob';
    return `${s3BasePath}/${applywizz_id}/${applywizz_id}|${safeCompany}|${safeJobName}.png`;
}

// --- MAIN RUNNER ---
async function main() {
    log('SYSTEM', `Starting Screenshot Recapture Script...`);
    log('SYSTEM', `Mode: ${isTestMode ? 'TEST (1 client, max 3 jobs)' : 'FULL RUN'}`);
    if (targetClientId) log('SYSTEM', `Target Client: ${targetClientId}`);
    if (jobLimit !== Infinity) log('SYSTEM', `Job Limit: ${jobLimit}`);

    const pg = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    await pg.connect();

    let browser;
    try {
        log('SYSTEM', '1. Querying PostgreSQL for completed jobs...');
        let query = `
            SELECT 
                d.id,
                d.applywizz_id,
                d.url,
                d.name,
                d.company,
                d.screenshot,
                c.company_email
            FROM dicev2_applied_jobs d
            JOIN clients_additional_info c ON d.applywizz_id = c.applywizz_id
            WHERE d.status = 'Completed' 
              AND d.screenshot IS NOT NULL 
              AND d.screenshot != ''
        `;
        const params = [];

        if (targetClientId) {
            params.push(targetClientId);
            query += ` AND d.applywizz_id = $${params.length}`;
        }

        query += ` ORDER BY d.applywizz_id, d.id ASC`;

        const res = await pg.query(query, params);
        const allJobs = res.rows;
        log('SYSTEM', `Found ${allJobs.length} total completed jobs in database.`);

        if (allJobs.length === 0) {
            log('SYSTEM', 'No jobs found matching criteria. Exiting.');
            return;
        }

        // Group jobs by client
        const clientMap = new Map();
        for (const job of allJobs) {
            if (!clientMap.has(job.applywizz_id)) {
                clientMap.set(job.applywizz_id, {
                    applywizz_id: job.applywizz_id,
                    company_email: job.company_email,
                    jobs: []
                });
            }
            clientMap.get(job.applywizz_id).jobs.push(job);
        }

        let clients = Array.from(clientMap.values());
        if (isTestMode) {
            clients = clients.slice(0, 1);
        }

        log('SYSTEM', `Processing ${clients.length} client(s)...`);

        browser = await chromium.launch({
            headless: isHeadless,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        let totalOverwritten = 0;
        let totalSkipped = 0;
        let totalProcessed = 0;

        for (let cIdx = 0; cIdx < clients.length; cIdx++) {
            const client = clients[cIdx];
            const { applywizz_id, company_email, jobs } = client;

            log(applywizz_id, `[Client ${cIdx + 1}/${clients.length}] Starting client ${applywizz_id} (${company_email}) - ${jobs.length} jobs`);

            // Filter out already processed jobs unless --force
            const pendingJobs = forceRecheck ? jobs : jobs.filter(j => 
                !progress.completedJobIds.includes(j.id) && !progress.skippedJobIds.includes(j.id)
            );

            if (pendingJobs.length === 0) {
                log(applywizz_id, `All ${jobs.length} jobs already processed in checkpoint. Skipping client.`);
                continue;
            }

            log(applywizz_id, `${pendingJobs.length} pending jobs to process.`);

            // Retrieve session from PostgreSQL
            let storageStateObj = null;
            const tempSessionPath = path.join(sessionsDir, `recapture_${applywizz_id}.json`);
            try {
                const sRes = await pg.query('SELECT session_state FROM dicev2_sessions WHERE email_id = $1', [company_email]);
                if (sRes.rows.length > 0 && sRes.rows[0].session_state) {
                    storageStateObj = sRes.rows[0].session_state;
                    fs.writeFileSync(tempSessionPath, JSON.stringify(storageStateObj));
                }
            } catch (err) {
                log(applywizz_id, `Notice: Could not load DB session: ${err.message}`);
            }

            const context = await browser.newContext({
                storageState: fs.existsSync(tempSessionPath) ? tempSessionPath : undefined,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                viewport: { width: 1280, height: 900 }
            });
            const page = await context.newPage();

            let isLoggedIn = false;
            try {
                log(applywizz_id, 'Checking session status at https://www.dice.com/dashboard/login ...');
                await page.goto('https://www.dice.com/dashboard/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await sleep(4000);

                const currentUrl = page.url();
                const emailInput = page.locator('input[name="email"]').first()
                    .or(page.locator('input[type="email"]').first())
                    .or(page.locator('input[inputmode="email"]').first());

                const isEmailVisible = await emailInput.isVisible().catch(() => false);

                if (!currentUrl.includes('/login') || !isEmailVisible) {
                    log(applywizz_id, `Session active! Current URL: ${currentUrl}`);
                    isLoggedIn = true;
                } else {
                    log(applywizz_id, `Session expired or not logged in. Initiating human-cadence login with ${company_email}...`);
                    
                    // 1. Wait 5s before typing email
                    log(applywizz_id, 'Waiting 5s before entering email...');
                    await sleep(5000);
                    await emailInput.fill(company_email);

                    // 2. Wait 5s before clicking continue
                    log(applywizz_id, 'Waiting 5s before clicking Continue...');
                    await sleep(5000);
                    const continueBtn = page.locator('[data-testid="sign-in-button"]')
                        .or(page.locator('button:has-text("Continue with email")'))
                        .or(page.locator('button[type="submit"]'))
                        .first();
                    await continueBtn.click();

                    // 3. Wait 5s for password field to appear
                    log(applywizz_id, 'Waiting 5s for password field to appear...');
                    await sleep(5000);
                    const passwordInput = page.locator('input[name="password"]').first();
                    await passwordInput.waitFor({ state: 'visible', timeout: 20000 });

                    // 4. Fill password
                    const password = process.env.DICE_PASSWORD;
                    if (!password) throw new Error('DICE_PASSWORD is not set in .env');
                    await passwordInput.fill(password);

                    // 5. Wait 5s before clicking submit password
                    log(applywizz_id, 'Waiting 5s before clicking Sign In...');
                    await sleep(5000);
                    const submitPassBtn = page.locator('[data-testid="submit-password"]')
                        .or(page.locator('button[type="submit"]'))
                        .first();
                    await submitPassBtn.click();

                    // 6. Wait for navigation away from login
                    log(applywizz_id, 'Waiting for authentication redirect to /home-feed...');
                    await page.waitForURL(url => !url.toString().includes('/login') || url.toString().includes('feed') || url.toString().includes('dashboard'), { timeout: 30000 });
                    await sleep(3000);

                    // Verify not trapped on login
                    const stillOnLogin = page.url().includes('/login');
                    if (stillOnLogin) {
                        throw new Error('Login trapped on login screen (possible Captcha or invalid credentials)');
                    }

                    log(applywizz_id, 'Login successful! Saving fresh cookies to PostgreSQL dicev2_sessions...');
                    await context.storageState({ path: tempSessionPath });
                    const freshState = JSON.parse(fs.readFileSync(tempSessionPath, 'utf8'));
                    await pg.query(`
                        INSERT INTO dicev2_sessions (email_id, session_state)
                        VALUES ($1, $2)
                        ON CONFLICT (email_id) DO UPDATE SET session_state = EXCLUDED.session_state
                    `, [company_email, freshState]);
                    isLoggedIn = true;
                }
            } catch (authErr) {
                log(applywizz_id, `WARNING: Login verification failed: ${authErr.message}`);
                log(applywizz_id, `Skipping client ${applywizz_id}. Existing screenshots preserved intact.`);
                progress.failedClientIds.push(applywizz_id);
                saveProgress();
                await page.close();
                await context.close();
                continue;
            }

            if (!isLoggedIn) {
                log(applywizz_id, 'Client not logged in. Skipping.');
                await page.close();
                await context.close();
                continue;
            }

            // --- PROCESS JOBS FOR THIS CLIENT ---
            for (let jIdx = 0; jIdx < pendingJobs.length; jIdx++) {
                if (totalProcessed >= jobLimit) {
                    log('SYSTEM', `Reached job processing limit of ${jobLimit}. Stopping.`);
                    break;
                }

                const job = pendingJobs[jIdx];
                log(applywizz_id, `[Job ${jIdx + 1}/${pendingJobs.length}] (ID: ${job.id}) Opening ${job.url}`);

                try {
                    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
                    
                    // 7-second pause for DOM and React state hydration
                    log(applywizz_id, 'Pausing 7 seconds for DOM and React state hydration...');
                    await sleep(7000);

                    // Check for "Applied" button
                    const appliedButton = page.locator('button[data-testid="apply-button"]').filter({ hasText: /Applied/i })
                        .or(page.locator('button').filter({ hasText: /Applied/i }))
                        .first();

                    let isAppliedVisible = false;
                    try {
                        await appliedButton.waitFor({ state: 'visible', timeout: 10000 });
                        isAppliedVisible = true;
                    } catch (e) {
                        isAppliedVisible = false;
                    }

                    if (isAppliedVisible) {
                        log(applywizz_id, `Confirmed "Applied" button visible. Capturing clean full-page screenshot...`);
                        const screenshotBuffer = await page.screenshot({ fullPage: true });

                        const s3Key = getS3KeyFromUrl(job.screenshot, applywizz_id, job.company, job.name);
                        log(applywizz_id, `Overwriting in AWS S3: ${s3Key} ...`);

                        await s3.send(new PutObjectCommand({
                            Bucket: s3Bucket,
                            Key: s3Key,
                            Body: screenshotBuffer,
                            ContentType: 'image/png',
                            CacheControl: 'max-age=0, no-cache, no-store, must-revalidate'
                        }));

                        log(applywizz_id, `SUCCESS: Overwritten S3 screenshot for Job ${job.id}`);
                        totalOverwritten++;
                        progress.completedJobIds.push(job.id);
                    } else {
                        log(applywizz_id, `Notice: "Applied" button not found or job expired. Keeping existing screenshot intact.`);
                        totalSkipped++;
                        progress.skippedJobIds.push(job.id);
                    }

                    totalProcessed++;
                    saveProgress();

                    // Short 1.5s gap between jobs
                    await sleep(1500);

                } catch (jobErr) {
                    log(applywizz_id, `Error processing Job ${job.id}: ${jobErr.message}. Keeping existing screenshot intact.`);
                    totalSkipped++;
                    progress.skippedJobIds.push(job.id);
                    totalProcessed++;
                    saveProgress();
                }
            }

            await page.close();
            await context.close();

            // Clean up temp session file if exists
            if (fs.existsSync(tempSessionPath)) {
                try { fs.unlinkSync(tempSessionPath); } catch (e) {}
            }

            if (totalProcessed >= jobLimit) break;
        }

        log('SYSTEM', '==================================================');
        log('SYSTEM', `Recapture Run Complete!`);
        log('SYSTEM', `Total Processed: ${totalProcessed}`);
        log('SYSTEM', `Successfully Overwritten in S3: ${totalOverwritten}`);
        log('SYSTEM', `Skipped (Button not found/expired): ${totalSkipped}`);
        log('SYSTEM', `Failed / Blocked Clients: ${progress.failedClientIds.length}`);
        log('SYSTEM', `Checkpoint saved at: ${progressFile}`);
        log('SYSTEM', '==================================================');

    } catch (fatalErr) {
        log('SYSTEM', `FATAL ERROR: ${fatalErr.message}`);
    } finally {
        if (browser) await browser.close();
        await pg.end();
        saveProgress();
    }
}

// Handle clean shutdown on Ctrl+C
process.on('SIGINT', () => {
    console.log('\n[SIGINT] Interrupted by user. Saving progress checkpoint and exiting cleanly...');
    saveProgress();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n[SIGTERM] Terminated. Saving progress checkpoint and exiting cleanly...');
    saveProgress();
    process.exit(0);
});

main();
