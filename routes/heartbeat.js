var express = require('express');
var Heartbeat = require('../services/heartbeat');
var logger = require('../utils/logger');

const SHARED_KEY = process.env.SHARED_KEY || 'SHAREDKEY';

let storageImpl;
if (process.env.STORAGE) {
  storageImpl = require(`../storages/${process.env.STORAGE}`);
} else {
  logger.warn('Warning! Storage not set. Environmental variable STORAGE needs to ' +
    'contain name of storage file inside /storages directory (without extension). Now using mock storage.');
  storageImpl = require('../storages/mock');
}
var router = express.Router();

// GET /healthcheck
router.get('/healthcheck', function (req, res) {
  res.sendStatus(200);
});

// POST /heartbeat
router.post('/heartbeat', async function (req, res) {
  let hb_request = {
    body: req.body
  };

  let hb_response = await Heartbeat.processRequest(hb_request, storageImpl, currentTimeISOString(), SHARED_KEY);

  res.set('Content-Type', 'application/json');
  res.status(hb_response.status).send(hb_response.body);
});

function currentTimeISOString() {
  return (new Date()).toISOString();
}

module.exports = router;
