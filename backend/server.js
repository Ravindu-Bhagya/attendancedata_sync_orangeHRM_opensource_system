'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const attendanceRoutes = require('./routes/attendanceRoutes');
const { oauthStart, oauthCallback } = require('./controllers/attendanceController');

const app = express();

app.use(cors());
app.use(express.json());

// OAuth2 callback routes (before static, so they aren't swallowed)
app.get('/oauth/start',    oauthStart);
app.get('/oauth/callback', oauthCallback);

app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/api/attendance', attendanceRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Attendance Integration server running on http://localhost:${PORT}`);
});
