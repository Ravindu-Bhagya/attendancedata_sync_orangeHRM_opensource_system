'use strict';

const form        = document.getElementById('importForm');
const submitBtn   = document.getElementById('submitBtn');
const btnText     = document.getElementById('btnText');
const btnSpinner  = document.getElementById('btnSpinner');
const terminal    = document.getElementById('terminal');
const statusDot   = document.getElementById('statusDot');
const statusTxt   = document.getElementById('statusText');
const fileInput   = document.getElementById('csvFile');
const dropZone    = document.getElementById('dropZone');
const dropLabel   = document.getElementById('dropLabel');
const fileChosen  = document.getElementById('fileChosen');
const clearBtn    = document.getElementById('clearBtn');
const summaryBanner = document.getElementById('summaryBanner');
const summaryIcon   = document.getElementById('summaryIcon');
const summaryTitle  = document.getElementById('summaryTitle');
const summaryDetail = document.getElementById('summaryDetail');
const summaryInner  = document.querySelector('.summary-inner');

// Connection elements
const connDot          = document.getElementById('connDot');
const connLabel        = document.getElementById('connLabel');
const connBarRight     = document.getElementById('connBarRight');
const connectForm      = document.getElementById('connectForm');
const connError        = document.getElementById('connError');
const connectBtn       = document.getElementById('connectBtn');
const connectBtnText   = document.getElementById('connectBtnText');
const connectBtnSpinner= document.getElementById('connectBtnSpinner');
const cInstanceUrl     = document.getElementById('cInstanceUrl');
const cUsername        = document.getElementById('cUsername');
const cPassword        = document.getElementById('cPassword');

let connectedBaseUrl = '';

// ── Connection state ─────────────────────────────────────────────────────────

async function checkConnection() {
  try {
    const r = await fetch('/api/attendance/status');
    const { connected } = await r.json();
    setConnected(connected);
    return connected;
  } catch {
    setConnected(false);
    return false;
  }
}

function setConnected(connected) {
  connDot.className = 'conn-dot ' + (connected ? 'ok' : 'err');
  connLabel.textContent = connected ? 'Connected to OrangeHRM' : 'Not connected';

  connBarRight.innerHTML = '';
  if (connected) {
    connectForm.hidden = true;
    submitBtn.disabled = false;

    const discBtn = document.createElement('button');
    discBtn.type = 'button';
    discBtn.className = 'btn-disc';
    discBtn.textContent = 'Disconnect';
    discBtn.onclick = async () => {
      await fetch('/api/attendance/disconnect', { method: 'POST' });
      connectedBaseUrl = '';
      checkConnection();
    };
    connBarRight.appendChild(discBtn);
  } else {
    connectForm.hidden = false;
    submitBtn.disabled = true;
    connError.hidden = true;
  }
}

connectBtn.addEventListener('click', async () => {
  const instanceUrl = cInstanceUrl.value.trim().replace(/\/$/, '');
  const username = cUsername.value.trim();
  const password = cPassword.value;
  if (!instanceUrl) { showConnError('Enter the OrangeHRM instance URL'); return; }
  if (!username || !password) { showConnError('Enter username and password'); return; }

  connectBtnText.hidden   = true;
  connectBtnSpinner.hidden = false;
  connectBtn.disabled     = true;
  connError.hidden        = true;

  try {
    const r = await fetch('/api/attendance/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: instanceUrl, username, password }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Connection failed');
    connectedBaseUrl = instanceUrl;
    setConnected(true);
  } catch (err) {
    showConnError(err.message);
  } finally {
    connectBtnText.hidden    = false;
    connectBtnSpinner.hidden = true;
    connectBtn.disabled      = false;
  }
});

function showConnError(msg) {
  connError.textContent = msg;
  connError.hidden = false;
}

checkConnection();

// ── Sample CSV download ──────────────────────────────────────────────────────
document.getElementById('downloadSample').addEventListener('click', () => {
  const header = 'employee_id,punch_in_date,punch_in_time,punch_in_note,punch_out_date,punch_out_time,punch_out_note';
  const rows = [
    'EMP-001,2025-01-15,09:00,Morning check-in,2025-01-15,17:30,Evening check-out',
    'EMP-002,2025-01-15,08:45,Regular,2025-01-15,17:00,Regular',
    'EMP-003,2025-01-16,09:15,,2025-01-16,18:00,',
  ];
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'attendance_sample.csv';
  a.click();
});

// ── Drag & drop ──────────────────────────────────────────────────────────────
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.csv')) {
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    showFileName(file.name);
  }
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) showFileName(fileInput.files[0].name);
});

function showFileName(name) {
  fileChosen.textContent = `Selected: ${name}`;
  dropLabel.innerHTML = `<span class="drop-icon">&#128196;</span><span>${name}</span>`;
}

// ── Terminal helpers ─────────────────────────────────────────────────────────
function appendLine(type, text) {
  const welcome = terminal.querySelector('.term-welcome');
  if (welcome) welcome.remove();

  const p = document.createElement('p');
  p.className = `log-line log-${type}`;

  const prefix = { info: 'ℹ ', success: '✔ ', warn: '⚠ ', error: '✖ ', divider: '', summary: '► ' }[type] || '';
  p.textContent = prefix + text;
  terminal.appendChild(p);
  terminal.scrollTop = terminal.scrollHeight;
}

clearBtn.addEventListener('click', () => {
  terminal.innerHTML = '<p class="term-welcome">Log cleared.</p>';
  summaryBanner.hidden = true;
  setStatus('ready');
});

function setStatus(state) {
  statusDot.className = 'status-dot';
  if (state === 'running') { statusDot.classList.add('running'); statusTxt.textContent = 'Importing …'; }
  else if (state === 'error') { statusDot.classList.add('error'); statusTxt.textContent = 'Finished with errors'; }
  else if (state === 'done') { statusDot.classList.add('done'); statusTxt.textContent = 'Done'; }
  else { statusTxt.textContent = 'Ready'; }
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  btnText.hidden     = busy;
  btnSpinner.hidden  = !busy;
}

// ── Form submit ──────────────────────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!fileInput.files[0]) { alert('Please select a CSV file first.'); return; }

  terminal.innerHTML = '';
  summaryBanner.hidden = true;
  setBusy(true);
  setStatus('running');

  const fd = new FormData(form);
  if (connectedBaseUrl) fd.append('baseUrl', connectedBaseUrl);

  let sessionId;
  try {
    const resp = await fetch('/api/attendance/import', { method: 'POST', body: fd });

    if (resp.status === 401) {
      appendLine('error', 'Not connected to OrangeHRM. Please connect first.');
      setBusy(false);
      setStatus('error');
      setConnected(false);
      return;
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.message || err.error || 'Upload failed');
    }
    ({ sessionId } = await resp.json());
  } catch (err) {
    appendLine('error', `Failed to start import: ${err.message}`);
    setBusy(false);
    setStatus('error');
    return;
  }

  // ── SSE stream ─────────────────────────────────────────────────────────────
  const es = new EventSource(`/api/attendance/stream/${sessionId}`);
  let succeeded = 0, failed = 0;

  es.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'done') {
      es.close(); setBusy(false);
      setStatus(failed > 0 ? 'error' : 'done');
      showSummary(succeeded, failed);
      return;
    }
    if (msg.type === 'summary') { succeeded = msg.succeeded || 0; failed = msg.failed || 0; }
    appendLine(msg.type || 'info', msg.text || '');
  };

  es.onerror = () => {
    es.close();
    appendLine('error', 'Connection to server lost');
    setBusy(false);
    setStatus('error');
  };
});

// ── Summary banner ───────────────────────────────────────────────────────────
function showSummary(succeeded, failed) {
  const total = succeeded + failed;
  const hasErrors = failed > 0;
  summaryInner.className = 'summary-inner' + (hasErrors ? ' has-errors' : '');
  summaryIcon.textContent = hasErrors ? (succeeded > 0 ? '⚠' : '✖') : '✔';
  summaryIcon.style.color = hasErrors ? (succeeded > 0 ? '#f39c12' : '#e74c3c') : '#76BC21';
  summaryTitle.textContent = succeeded === total
    ? 'All Records Imported Successfully'
    : `Import Complete — ${succeeded} of ${total} succeeded`;
  summaryDetail.textContent =
    `${succeeded} record(s) imported, ${failed} record(s) failed.` +
    (failed > 0 ? ' Check the log above for details on failed records.' : '');
  summaryBanner.hidden = false;
  summaryBanner.scrollIntoView({ behavior: 'smooth' });
}
