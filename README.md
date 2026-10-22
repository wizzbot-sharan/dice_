# Dice Job Application Automation Engine

An autonomous, multi-client job application engine built with Node.js, Playwright, and PostgreSQL. The system continuously ingests scraped jobs, manages client application queues, simulates human-like browser applications on Dice.com, verifies email application receipts via Zoho Mail, and exposes a real-time web dashboard for live monitoring and manual overrides.

---

## Table of Contents
- [Part 1: Business Logic & Operational Workflows](#part-1-business-logic--operational-workflows)
  - [1. System Overview](#1-system-overview)
  - [2. Daily Schedule & Automation Lifecycle (IST)](#2-daily-schedule--automation-lifecycle-ist)
  - [3. The 10-Application Daily Cap Rule](#3-the-10-application-daily-cap-rule)
  - [4. Anti-Detection & Cooldown Pacing](#4-anti-detection--cooldown-pacing)
  - [5. Failproof Client Purging](#5-failproof-client-purging)
  - [6. Zoho Email Receipt Verification](#6-zoho-email-receipt-verification)
  - [7. Real-Time Operations Dashboard](#7-real-time-operations-dashboard)
- [Part 2: Developer & Technical Guide](#part-2-developer--technical-guide)
  - [1. Technology Stack](#1-technology-stack)
  - [2. System Architecture & Components](#2-system-architecture--components)
  - [3. Local Setup & Execution](#3-local-setup--execution)
  - [4. Docker & Railway Deployment](#4-docker--railway-deployment)
  - [5. API Endpoints Reference](#5-api-endpoints-reference)

---

# Part 1: Business Logic & Operational Workflows

### 1. System Overview
The automation handles multi-tenant job applications across hundreds of candidate profiles simultaneously. Instead of batching applications aggressively, it staggers them across individual client queues, adhering to per-client application limits, Dice anti-bot constraints, and CRM onboarding statuses.

---

### 2. Daily Schedule & Automation Lifecycle (IST)
The engine operates on a strict schedule aligned with Indian Standard Time (IST / UTC+5:30):

- **10:00 AM IST — Client Status Polling Starts:**
  The background poller activates and queries the external Client Status API every 15 minutes. It discovers newly completed/onboarded clients who are ready for applications and prepares their initial job pipelines.
- **5:00 PM IST — Main Scheduled Automation Kickoff:**
  The primary scheduled run begins. It merges all qualified clients and fresh scraped jobs from the last 12 hours into active execution queues.
- **Continuous 30-Minute Ingestion:**
  While automation is running, a background poller checks PostgreSQL every 30 minutes for newly scraped jobs matching active clients and adds them to backlogs. If queues are completely empty for 2 consecutive 30-minute cycles, the active run terminates automatically to conserve compute.
- **11:59 PM IST — Hard Cutoff & System Reset:**
  Regardless of running jobs or pending queues, a hard stop triggers at 11:59 PM IST. Any ongoing browser contexts are closed, memory and live queues are purged, and daily counters are reset for the next morning.

---

### 3. The 10-Application Daily Cap Rule
To protect candidate accounts from platform flags and ensure fair job distribution:
- Each candidate has a strict hard limit of **10 successfully completed job applications per calendar day**.
- Application counts are tracked live in memory and persisted in the database table `dicev2_client_counters`.
- Once a client reaches 10 completions, all remaining pending jobs for that client are dropped from the active queue and master backlog immediately.
- Subsequent pollers check the 10-cap guard before ingesting any new jobs for that candidate.

---

### 4. Anti-Detection & Cooldown Pacing
To mimic human browsing habits and prevent Dice rate-limiting:
- **Concurrency Control:** Limits the total number of simultaneous browser instances (default 10 concurrent workers).
- **Client Cooldown Delay:** After a client finishes an application, their next job enters a mandatory randomized **20 to 30-minute cooldown period**.
- **Humanized Navigation:** Playwright sessions employ randomized delays during form fills, clicks, file attachments, and page navigation.

---

### 5. Failproof Client Purging
Clients can be purged from the active run either manually (via the dashboard or `/api/purge-client`) or automatically when a fatal login failure occurs (`"Login Failed: Invalid credentials or account blocked."`).

The purge follows a 3-layer failproof sequence:
1. **In-Memory Exclusion:** The client ID is added to `purgedClientsToday` and `fatalLoginClients`, immediately preventing any poller or promotion loop from queuing them.
2. **Queue Eviction:** All remaining pending/cooldown jobs for that client are removed from the in-memory `masterBacklog` and `jobQueue`.
3. **Database Persistence:**
   - Remaining jobs are deleted from `dicev2_master_backlog` and non-processing jobs in `dicev2_live_queue`.
   - A persistent record is written:
     ```sql
     INSERT INTO trigger_client (applywizz_id, status)
     VALUES ($1, 'purged')
     ON CONFLICT (applywizz_id) DO UPDATE SET status = 'purged';
     ```
   - Because `trigger_client` holds this record until the 11:59 PM IST reset, container restarts on Railway will not reload or restart this client.

---

### 6. Zoho Email Receipt Verification
To guarantee that Dice actually forwarded the candidate's application to the employer:
- **API Precheck:** Before running, the worker validates candidate email addresses against a Zoho Mail Reader microservice.
- **Asynchronous Detached Polling:** When an application is submitted, a background routine checks the candidate's Zoho inbox for a confirmation email from `applyonline@dice.com`.
- **Matching Criteria:** Matches subject lines against the applied job title and company name, within a window around submission time.
- **Status Reporting:** Successful matches update the application record in `dicev2_applied_jobs` with full email proof (timestamp, sender, recipient, subject). If no email arrives after 10 minutes, it is marked as `zoho skipped`.

---

### 7. Real-Time Operations Dashboard
The service hosts an interactive web dashboard providing operational visibility:
- **Live Counter Cards:** Active Workers, Live Queue size, Master Backlog count, and Total Completed today.
- **Active Job Monitor:** Shows the current URL, candidate, status (`PROCESSING`, `COOLDOWN`, `PENDING`), and cooldown timers.
- **Client Search & Modal:** Search any candidate to view their complete application history, failure reasons, and application screenshots.
- **Manual Actions:** Triggers for starting runs, terminating runs, manually purging specific clients, and triggering single client runs.

---

# Part 2: Developer & Technical Guide

### 1. Technology Stack
- **Runtime:** Node.js (v20+ with `--expose-gc` flag for Playwright memory management)
- **Web Server:** Express.js (serving REST API and static React build)
- **Browser Automation:** Playwright with Chromium (stealth args, randomized user agents, headless toggle)
- **Database:** PostgreSQL (with `pg` connection pool)
- **Object Storage:** Object storage service for application submission screenshots
- **Scheduler:** `node-cron` for IST daily timetable triggers
- **Frontend:** React + Vite (compiled into `public/`)

---

### 2. System Architecture & Components

```
                   +----------------------------------+
                   |    Client Status API (10 AM)     |
                   +-----------------+----------------+
                                     |
                                     v
+-----------------------+    +-------+--------+    +-----------------------+
|  dice_scraped_jobs    |--->|                |--->|  dicev2_live_queue    |
|  (30-min poller)      |    |   worker.js    |    |  (Active Queue in DB) |
+-----------------------+    |  (Queue & State|    +-----------------------+
                             |   Controller)  |
+-----------------------+    |                |    +-----------------------+
|  Zoho Mail Reader API |<---|                |--->| dicev2_applied_jobs   |
|  (Receipt Validation) |    +-------+--------+    | (Historical Results)  |
+-----------------------+            |             +-----------------------+
                                     v
                             +----------------+
                             |   Playwright   |
                             | (Chromium Bot) |
                             +----------------+
```

- **`worker.js`**: Core entry point containing the Express server, cron schedules, queue management loops, Playwright automation handlers, and Zoho polling routines.
- **`dashboard/`**: React source code for the monitoring UI. Builds into the root `public/` directory.
- **`dicev2_applied_jobs`**: Stores audit logs for every application attempt (status, failure reason, screenshot URL, email proof JSON).
- **`dicev2_client_counters`**: Stores daily completed application counts per client.
- **`trigger_client`**: Tracks client processing states, manually triggered clients, and daily purged exclusions.

---

### 3. Local Setup & Execution

#### Prerequisites
- Node.js 20 or higher
- Database connectivity
- Playwright system dependencies

#### 1. Clone & Install Dependencies
```bash
# Install root backend dependencies
npm install

# Install dashboard frontend dependencies
cd dashboard
npm install
cd ..
```

#### 2. Build the Dashboard
```bash
cd dashboard
npm run build
cd ..
```
*This compiles the React dashboard into the `public/` directory served by Express.*

#### 3. Install Playwright Browsers
```bash
npx playwright install chromium
```

#### 4. Run the Worker
```bash
# Run with garbage collection enabled for Playwright stability
node --expose-gc worker.js
```

Access the dashboard at the configured port.

---

### 4. Docker & Railway Deployment

The repository includes a multi-stage `Dockerfile`:
- **Stage 1 (`frontend-builder`):** Compiles the React dashboard using `node:20-alpine`.
- **Stage 2 (Production):** Uses `mcr.microsoft.com/playwright:v1.64.0-jammy` to provide all native browser libraries and dependencies, copies the compiled UI into `public/`, and runs `node --expose-gc worker.js`.

#### Docker Build & Run Locally
```bash
# Build Docker image
docker build -t dice-automation .

# Run container
docker run -p 3000:3000 dice-automation
```

#### Railway Deployment
1. Connect this GitHub repository to your Railway project.
2. Railway automatically detects the root `Dockerfile`.
3. Configure the necessary environment variables in the Railway dashboard.
4. Expose the application port.

---

### 5. API Endpoints Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Serves the React operations dashboard. |
| `GET` | `/api/dashboard-stats` | Returns real-time counts, queue size, and active worker count. |
| `GET` | `/api/active-queue` | Returns jobs currently in the live queue (`PROCESSING`, `COOLDOWN`, `PENDING`). |
| `GET` | `/api/client-jobs` | Returns applied history for a client (`?applywizz_id=ID`). |
| `POST` | `/api/start-run` | Manually triggers the scheduled automation run immediately. |
| `POST` | `/api/terminate-run` | Hard stops all active workers and clears running queues. |
| `POST` | `/api/purge-client` | Purges a specific candidate across RAM queues, DB backlog, and marks them `purged` in `trigger_client` (`{ applywizz_id }`). |
| `POST` | `/api/trigger-single-client` | Immediately stages and queues available jobs for a specific candidate. |
