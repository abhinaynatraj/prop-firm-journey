// ocr.js — wraps the Swift Vision OCR script
// Runs the helper script, captures JSON, returns line objects with normalized
// coordinates so we can group them into rows in account-parser.js.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SWIFT_SCRIPT = path.join(__dirname, 'ocr.swift');

function runOCR(imageBuffer) {
  return new Promise((resolve, reject) => {
    // Write the buffer to a temp file (Swift script expects a path)
    const tmpFile = path.join(os.tmpdir(), `journal-ocr-${crypto.randomBytes(8).toString('hex')}.png`);
    try { fs.writeFileSync(tmpFile, imageBuffer); }
    catch (e) { return reject(e); }

    execFile('swift', [SWIFT_SCRIPT, tmpFile], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (err) {
        return reject(new Error(`Swift OCR failed: ${stderr || err.message}`));
      }
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch (e) {
        reject(new Error('Could not parse OCR output: ' + e.message));
      }
    });
  });
}

module.exports = { runOCR };
