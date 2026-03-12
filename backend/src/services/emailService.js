const nodemailer = require('nodemailer');

let transporter = null;

function init() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    console.warn('[Email] SMTP_USER/SMTP_PASS not set. Email features disabled.');
    return false;
  }

  // Detect provider from email address
  const isGmail = user.includes('@gmail');
  const isOutlook = user.includes('@hotmail') || user.includes('@outlook') || user.includes('@live');

  const config = isGmail
    ? { service: 'gmail', auth: { user, pass } }
    : isOutlook
    ? { host: 'smtp-mail.outlook.com', port: 587, secure: false, auth: { user, pass } }
    : { host: process.env.SMTP_HOST || 'smtp.gmail.com', port: parseInt(process.env.SMTP_PORT || '587'), secure: false, auth: { user, pass } };

  transporter = nodemailer.createTransport(config);
  console.log(`[Email] Configured with ${user} (${isGmail ? 'Gmail' : isOutlook ? 'Outlook' : 'Custom SMTP'})`);
  return true;
}

async function sendPasswordReset(toEmail, username, resetUrl) {
  if (!transporter) {
    console.warn('[Email] Cannot send reset email — SMTP not configured');
    return false;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0a0a1a;color:#dff5ea;padding:30px;border-radius:12px;border:1px solid rgba(0,245,160,0.2)">
      <h2 style="color:#00f5a0;margin-bottom:20px">🔐 Password Reset</h2>
      <p>Hi <strong>${username}</strong>,</p>
      <p>You requested a password reset for your Crypto Dashboard account.</p>
      <p>Click the button below to reset your password. This link expires in <strong>1 hour</strong>.</p>
      <div style="text-align:center;margin:30px 0">
        <a href="${resetUrl}" style="background:#00f5a0;color:#000;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold;font-size:16px;display:inline-block">Reset Password</a>
      </div>
      <p style="color:#8aaa98;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
      <hr style="border:none;border-top:1px solid rgba(0,245,160,0.15);margin:20px 0">
      <p style="color:#5a7a68;font-size:11px;text-align:center">Crypto Dashboard — Ultimate Trading Platform</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"Crypto Dashboard" <${process.env.SMTP_USER}>`,
      to: toEmail,
      subject: 'Password Reset — Crypto Dashboard',
      html,
    });
    console.log(`[Email] Password reset sent to ${toEmail}`);
    return true;
  } catch (err) {
    console.error('[Email] Failed to send reset email:', err.message);
    return false;
  }
}

async function sendWelcome(toEmail, username) {
  if (!transporter) return false;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0a0a1a;color:#dff5ea;padding:30px;border-radius:12px;border:1px solid rgba(0,245,160,0.2)">
      <h2 style="color:#00f5a0;margin-bottom:20px">🚀 Welcome to Crypto Dashboard!</h2>
      <p>Hi <strong>${username}</strong>,</p>
      <p>Your account has been created successfully. You now have access to:</p>
      <ul style="color:#8aaa98;line-height:2">
        <li>📊 Advanced backtesting with 15+ indicators</li>
        <li>🎯 AI-powered trade probability engine</li>
        <li>📰 Real-time crypto news & sentiment</li>
        <li>🎲 Polymarket prediction markets</li>
        <li>💹 Live trading via BloFin</li>
      </ul>
      <p>Happy trading!</p>
      <hr style="border:none;border-top:1px solid rgba(0,245,160,0.15);margin:20px 0">
      <p style="color:#5a7a68;font-size:11px;text-align:center">Crypto Dashboard — Ultimate Trading Platform</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"Crypto Dashboard" <${process.env.SMTP_USER}>`,
      to: toEmail,
      subject: 'Welcome to Crypto Dashboard!',
      html,
    });
    return true;
  } catch (err) {
    console.error('[Email] Failed to send welcome email:', err.message);
    return false;
  }
}

module.exports = { init, sendPasswordReset, sendWelcome };
