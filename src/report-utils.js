/**
 * Shared utilities for report logging and email notifications.
 *
 * Provides:
 *  - ReportLogger: captures output to both console and file
 *  - sendReport: sends email with report content
 *
 * Env vars:
 *   REPORT_EMAIL_TO       – recipient email address
 *   SMTP_HOST             – SMTP server hostname
 *   SMTP_PORT             – SMTP port (default: 587)
 *   SMTP_USER             – SMTP username
 *   SMTP_PASS             – SMTP password
 *   SMTP_FROM             – sender address (default: SMTP_USER)
 *   REPORT_LOG_DIR        – directory for report logs (default: ./logs)
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

const LOG_DIR = process.env.REPORT_LOG_DIR || path.join(__dirname, '..', 'logs');

class ReportLogger {
  constructor(name) {
    this.name = name;
    this.lines = [];
    this.logFile = null;
  }

  /**
   * Log a line to console, buffer, and optionally file.
   */
  log(msg, level = 'INFO') {
    const ts = new Date().toLocaleString('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const line = level ? `[${ts}] [${this.name}] [${level}] ${msg}` : msg;
    console.log(line);
    this.lines.push(line);
  }

  /**
   * Log a plain line (no timestamp/prefix) for report formatting.
   */
  plain(msg) {
    console.log(msg);
    this.lines.push(msg);
  }

  /**
   * Get full report text.
   */
  getReport() {
    return this.lines.join('\n');
  }

  /**
   * Save report to a dated log file.
   * Returns the file path.
   */
  saveToFile(suffix = '') {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const filename = `${this.name.toLowerCase().replace(/\s+/g, '-')}${suffix ? '-' + suffix : ''}-${date}.log`;
    this.logFile = path.join(LOG_DIR, filename);

    fs.writeFileSync(this.logFile, this.getReport() + '\n', 'utf8');
    console.log(`Report saved to: ${this.logFile}`);
    return this.logFile;
  }
}

/**
 * Send an email report.
 * @param {string} subject - email subject
 * @param {string} body - plain text body
 * @param {string} [attachmentPath] - optional file to attach
 */
async function sendReport(subject, body, attachmentPath) {
  const to = process.env.REPORT_EMAIL_TO;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!to || !host) {
    console.log('Email not configured (set REPORT_EMAIL_TO + SMTP_HOST). Skipping email.');
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: (parseInt(process.env.SMTP_PORT) || 587) === 465,
      auth: (user && pass) ? { user, pass } : undefined,
    });

    const mailOptions = {
      from: process.env.SMTP_FROM || user || `solar-reports@${host}`,
      to,
      subject,
      text: body,
    };

    if (attachmentPath && fs.existsSync(attachmentPath)) {
      mailOptions.attachments = [{
        filename: path.basename(attachmentPath),
        path: attachmentPath,
      }];
    }

    await transporter.sendMail(mailOptions);
    console.log(`Report emailed to ${to}`);
    return true;
  } catch (err) {
    console.log(`Failed to send email: ${err.message}`);
    return false;
  }
}

module.exports = { ReportLogger, sendReport, LOG_DIR };
