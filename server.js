require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// === Proxy for elevation API to bypass CORS ===
app.get('/elevation', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });

  try {
    const response = await fetch(`https://api.opentopodata.org/v1/test-dataset?locations=${lat},${lon}`);
    if (!response.ok) throw new Error(`OpenTopo API error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Elevation fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch elevation' });
  }
});

// === Log GPS + elevation ===
app.post('/log', async (req, res) => {
  const { session_id, user_id, latitude, longitude, elevation } = req.body;
  if (!session_id || !user_id || !latitude || !longitude || !elevation) {
    return res.status(400).send('Missing data');
  }

  try {
    await pool.query(
      `INSERT INTO logs (session_id, user_id, latitude, longitude, elevation)
       VALUES ($1, $2, $3, $4, $5)`,
      [session_id, user_id, latitude, longitude, elevation]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database insert error');
  }
});

// === Login Page ===
app.get('/view', (req, res) => {
  res.send(`
    <h2>Login to View Logs</h2>
    <form method="POST" action="/view">
      <input type="text" name="username" placeholder="Username" required /><br>
      <input type="password" name="password" placeholder="Password" required /><br>
      <button type="submit">Login</button>
    </form>
  `);
});

app.post('/view', async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).send('Invalid credentials');
  }

  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT session_id, user_id, MIN(timestamp) as start_time
      FROM logs
      GROUP BY session_id, user_id
      ORDER BY start_time DESC
    `);

    let html = `<h1>Available Log Sessions</h1><ul>`;
    for (const row of rows) {
      html += `<li><a href="/view/session/${row.session_id}">Session: ${row.session_id} (User: ${row.user_id})</a></li>`;
    }
    html += `</ul>`;
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching sessions');
  }
});

// === CSV Export ===
app.get('/view/session/:session_id/export', async (req, res) => {
  const sessionId = req.params.session_id;

  try {
    const { rows } = await pool.query('SELECT * FROM logs WHERE session_id = $1 ORDER BY timestamp ASC', [sessionId]);
    if (rows.length === 0) return res.status(404).send('Session not found');

    res.setHeader('Content-disposition', `attachment; filename=${sessionId}.csv`);
    res.setHeader('Content-Type', 'text/csv');
    res.write('id,session_id,user_id,latitude,longitude,elevation,timestamp\n');
    for (const row of rows) {
      res.write(`${row.id},${row.session_id},${row.user_id},${row.latitude},${row.longitude},${row.elevation},${row.timestamp}\n`);
    }
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('CSV export error');
  }
});

// === Session View with Chart and Map ===
app.get('/view/session/:session_id', async (req, res) => {
  const sessionId = req.params.session_id;

  try {
    const { rows } = await pool.query('SELECT * FROM logs WHERE session_id = $1 ORDER BY timestamp ASC', [sessionId]);
    if (rows.length === 0) return res.status(404).send('Session not found');

    const coordinates = rows.map(r => `[${r.latitude}, ${r.longitude}]`).join(',');
    let html = `<h1>Session: ${sessionId}</h1>
      <button onclick="location.href='/view/session/${sessionId}/export'">Download CSV</button>
      <canvas id="chart" width="600" height="300"></canvas>
      <div id="map" style="height: 400px; margin-top: 20px;"></div>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.3/dist/leaflet.css" />
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <script src="https://unpkg.com/leaflet@1.9.3/dist/leaflet.js"></script>
      <script>
        const ctx = document.getElementById('chart').getContext('2d');
        new Chart(ctx, {
          type: 'line',
          data: {
            labels: [${rows.map(r => `"${new Date(r.timestamp).toLocaleTimeString()}"`).join(',')}],
            datasets: [{
              label: 'Elevation (m)',
              data: [${rows.map(r => r.elevation).join(',')}],
              borderWidth: 2,
              fill: false
            }]
          },
          options: { scales: { y: { beginAtZero: true } } }
        });

        const map = L.map('map').setView([${rows[0].latitude}, ${rows[0].longitude}], 14);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: 'Map data © <a href="https://openstreetmap.org">OpenStreetMap</a> contributors'
        }).addTo(map);

        const latlngs = [${coordinates}];
        L.polyline(latlngs, { color: 'blue' }).addTo(map);
        L.marker(latlngs[0]).addTo(map).bindPopup("Start").openPopup();
        L.marker(latlngs[latlngs.length - 1]).addTo(map).bindPopup("End");
      </script>`;
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Session view error');
  }
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));