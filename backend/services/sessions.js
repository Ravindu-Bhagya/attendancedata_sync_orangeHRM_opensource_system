'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

const sessions = new Map();

function createSession() {
  const sessionId = crypto.randomUUID();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);
  sessions.set(sessionId, emitter);
  return { sessionId, emitter };
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

module.exports = { createSession, getSession, deleteSession };
