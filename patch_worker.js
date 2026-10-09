const fs = require('fs');
let code = fs.readFileSync('worker.js', 'utf8');

const newCode = `
async function upsertTable(tableName, dataObj) {
    if (!dataObj || Object.keys(dataObj).length === 0) return;
    const keys = Object.keys(dataObj);
    const values = Object.values(dataObj);
    
    const cols = keys.map(k => \`"\${k}"\`).join(', ');
    const vals = keys.map((_, i) => \`$\${i + 1}\`).join(', ');
    
    const updates = keys.filter(k => k !== 'id')
                        .map(k => \`"\${k}" = EXCLUDED."\${k}"\`)
                        .join(', ');
    
    const query = \`
        INSERT INTO \${tableName} (\${cols})
        VALUES (\${vals})
        ON CONFLICT (id) DO UPDATE SET \${updates}
    \`;
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
                    const r = await fetch(\`https://www.apply-wizz.me/api/get-client-details?applywizz_id=\${id}\`);
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
                    sysLog(\`Failed to sync client \${id}: \${err.message}\`);
                }
            }));
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        if (toDelete.length > 0) {
            sysLog(\`Removing \${toDelete.length} inactive clients from DB.\`);
            const placeholders = toDelete.map((_, i) => \`$\${i+1}\`).join(',');
            
            // Delete safely catching errors in case of FK constraints
            await queryDB(\`DELETE FROM clients_additional_info WHERE applywizz_id IN (\${placeholders})\`, toDelete).catch(e => sysLog("Delete CAI Error: " + e.message));
            await queryDB(\`DELETE FROM client_profiles WHERE applywizz_id IN (\${placeholders})\`, toDelete).catch(e => sysLog("Delete CP Error: " + e.message));
        }
        
        sysLog('Client Sync Process Complete!');
    } catch (e) {
        sysLog(\`SYNC ERROR: \${e.message}\`);
    }
}

app.post('/api/sync-clients', async (req, res) => {
    sysLog('Client Sync activated via Dashboard.');
    syncClientsTask().catch(err => sysLog(\`SYNC RUN ERROR: \${err.message}\`));
    res.json({ message: 'Sync started successfully.' });
});
`;

code = code.replace("app.use((req, res) => {", newCode + "\napp.use((req, res) => {");
fs.writeFileSync('worker.js', code);
console.log('worker.js patched');
