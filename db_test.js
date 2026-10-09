require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const res1 = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'clients_additional_info';");
  console.log("clients_additional_info types:", res1.rows.filter(r => r.data_type === 'ARRAY' || r.data_type === 'json' || r.data_type === 'jsonb'));

  const res2 = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'client_profiles';");
  console.log("client_profiles types:", res2.rows.filter(r => r.data_type === 'ARRAY' || r.data_type === 'json' || r.data_type === 'jsonb'));
  
  process.exit();
}
run();
