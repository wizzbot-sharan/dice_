require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const res1 = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'clients_additional_info' AND column_name = 'imported_at'`);
  console.log("imported_at type:", res1.rows[0].data_type);
  
  const res2 = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'client_profiles' AND column_name = 'Time Zone'`);
  console.log("Time Zone type:", res2.rows[0].data_type);

  process.exit();
}
run();
