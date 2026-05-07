'use strict';

const fs = require('fs');

const REQUIRED_COLUMNS = [
  'employee_id',
  'punch_in_date',
  'punch_in_time',
  'punch_in_note',
  'punch_out_date',
  'punch_out_time',
  'punch_out_note',
];

// Minimal RFC-4180 CSV parser (handles quoted fields with commas/newlines)
function parseCSV(content) {
  const rows = [];
  let i = 0;
  const len = content.length;

  while (i < len) {
    const row = [];
    while (i < len && content[i] !== '\n') {
      if (content[i] === '"') {
        let field = '';
        i++; // skip opening quote
        while (i < len) {
          if (content[i] === '"' && content[i + 1] === '"') {
            field += '"';
            i += 2;
          } else if (content[i] === '"') {
            i++;
            break;
          } else {
            field += content[i++];
          }
        }
        row.push(field.trim());
        if (i < len && content[i] === ',') i++;
      } else {
        let field = '';
        while (i < len && content[i] !== ',' && content[i] !== '\n') {
          field += content[i++];
        }
        row.push(field.trim());
        if (i < len && content[i] === ',') i++;
      }
    }
    if (i < len) i++; // skip \n

    // Skip blank rows
    if (row.length > 0 && row.some(c => c !== '')) rows.push(row);
  }

  return rows;
}

function parseFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = parseCSV(raw);

  if (rows.length < 2) {
    throw new Error('CSV file is empty or has no data rows');
  }

  // Validate header
  const headers = rows[0].map(h => h.toLowerCase().trim());
  for (const col of REQUIRED_COLUMNS) {
    if (!headers.includes(col)) {
      throw new Error(`Missing required column: "${col}". Expected columns: ${REQUIRED_COLUMNS.join(', ')}`);
    }
  }

  const colIndex = {};
  for (const col of REQUIRED_COLUMNS) {
    colIndex[col] = headers.indexOf(col);
  }

  const records = [];
  const errors = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const lineNum = r + 1;

    const get = (col) => (row[colIndex[col]] || '').trim();

    const employeeId = get('employee_id');
    const punchInDate = get('punch_in_date');
    const punchInTime = get('punch_in_time');
    const punchOutDate = get('punch_out_date');
    const punchOutTime = get('punch_out_time');

    if (!employeeId) {
      errors.push({ line: lineNum, error: 'employee_id is empty' });
      continue;
    }

    // Date format: YYYY-MM-DD
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    // Time format: HH:MM
    const timeRe = /^\d{2}:\d{2}$/;

    if (!dateRe.test(punchInDate)) {
      errors.push({ line: lineNum, employeeId, error: `Invalid punch_in_date "${punchInDate}" — expected YYYY-MM-DD` });
      continue;
    }
    if (!timeRe.test(punchInTime)) {
      errors.push({ line: lineNum, employeeId, error: `Invalid punch_in_time "${punchInTime}" — expected HH:MM` });
      continue;
    }
    if (!dateRe.test(punchOutDate)) {
      errors.push({ line: lineNum, employeeId, error: `Invalid punch_out_date "${punchOutDate}" — expected YYYY-MM-DD` });
      continue;
    }
    if (!timeRe.test(punchOutTime)) {
      errors.push({ line: lineNum, employeeId, error: `Invalid punch_out_time "${punchOutTime}" — expected HH:MM` });
      continue;
    }

    // Basic sanity: punch-out must be after punch-in
    const inDT = new Date(`${punchInDate}T${punchInTime}:00`);
    const outDT = new Date(`${punchOutDate}T${punchOutTime}:00`);
    if (outDT <= inDT) {
      errors.push({ line: lineNum, employeeId, error: 'Punch-out time must be after punch-in time' });
      continue;
    }

    records.push({
      line: lineNum,
      employeeId,
      punchInDate,
      punchInTime,
      punchInNote: get('punch_in_note'),
      punchOutDate,
      punchOutTime,
      punchOutNote: get('punch_out_note'),
    });
  }

  return { records, errors };
}

module.exports = { parseFile, REQUIRED_COLUMNS };
