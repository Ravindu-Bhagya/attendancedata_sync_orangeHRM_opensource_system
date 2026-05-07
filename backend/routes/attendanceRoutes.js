'use strict';

const express = require('express');
const router  = express.Router();
const { upload } = require('../services/fileService');
const {
  connect,
  importAttendance,
  attendanceStream,
  authStatus,
  disconnect,
} = require('../controllers/attendanceController');

router.post('/connect',          connect);
router.post('/import',           upload.single('csv'), importAttendance);
router.get('/stream/:sessionId', attendanceStream);
router.get('/status',            authStatus);
router.post('/disconnect',       disconnect);

module.exports = router;
