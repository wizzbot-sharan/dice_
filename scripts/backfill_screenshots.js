const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Client } = require('pg');

async function main() {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();

    try {
        console.log('1. Ensuring column "screenshot" exists in dicev2_applied_jobs...');
        await pg.query(`
            ALTER TABLE dicev2_applied_jobs 
            ADD COLUMN IF NOT EXISTS screenshot TEXT;
        `);
        console.log('Column "screenshot" ready.');

        console.log('2. Fetching completed jobs needing backfill...');
        const res = await pg.query(`
            SELECT id, applywizz_id, name, company 
            FROM dicev2_applied_jobs 
            WHERE status = 'Completed' AND (screenshot IS NULL OR screenshot = '')
        `);
        const jobs = res.rows;
        console.log(`Found ${jobs.length} completed jobs remaining to backfill.`);

        if (jobs.length === 0) {
            console.log('All completed jobs already have screenshot URLs.');
            return;
        }

        const bucket = process.env.AWS_BUCKET_NAME || 'applywizz-prod-v2';
        const region = process.env.AWS_REGION || 'us-east-2';
        const basePath = process.env.AWS_S3_BASE_PATH || 'dice-applications/screenshots';

        console.log('3. Performing ultra-fast bulk updates...');
        const batchSize = 500;
        let totalUpdated = 0;

        for (let i = 0; i < jobs.length; i += batchSize) {
            const batch = jobs.slice(i, i + batchSize);
            const valueClauses = [];
            const params = [];
            let pIdx = 1;

            for (const job of batch) {
                const safeCompany = job.company ? job.company.replace(/[/\\?%*:|"<>\x00-\x1F]/g, '-') : 'UnknownCompany';
                const safeJobName = job.name ? job.name.replace(/[/\\?%*:|"<>\x00-\x1F]/g, '-') : 'UnknownJob';
                const objectKey = `${basePath}/${job.applywizz_id}/${job.applywizz_id}|${safeCompany}|${safeJobName}.png`;
                const screenshotUrl = `https://${bucket}.s3.${region}.amazonaws.com/${encodeURI(objectKey)}`;

                valueClauses.push(`($${pIdx++}::int, $${pIdx++}::text)`);
                params.push(job.id, screenshotUrl);
            }

            const query = `
                UPDATE dicev2_applied_jobs AS d
                SET screenshot = v.screenshot
                FROM (VALUES ${valueClauses.join(', ')}) AS v(id, screenshot)
                WHERE d.id = v.id;
            `;

            await pg.query(query, params);
            totalUpdated += batch.length;
            console.log(`Updated ${totalUpdated}/${jobs.length} jobs.`);
        }

        console.log('4. Verifying backfill results...');
        const verify = await pg.query(`
            SELECT 
                COUNT(*) as total_completed,
                COUNT(screenshot) as with_screenshot
            FROM dicev2_applied_jobs 
            WHERE status = 'Completed'
        `);
        console.log(`Total Completed: ${verify.rows[0].total_completed}`);
        console.log(`With Screenshot URL: ${verify.rows[0].with_screenshot}`);

        // Sample check
        const sample = await pg.query(`
            SELECT id, applywizz_id, name, company, screenshot 
            FROM dicev2_applied_jobs 
            WHERE status = 'Completed' 
            ORDER BY id DESC 
            LIMIT 3
        `);
        console.log('Sample updated rows:', JSON.stringify(sample.rows, null, 2));

    } catch (err) {
        console.error('Error during backfill:', err);
    } finally {
        await pg.end();
    }
}

main();
