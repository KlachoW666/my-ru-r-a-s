'use strict';

/**
 * Отправка писем.
 *
 * До этого коды подтверждения только печатались в лог — почтового сервера в
 * проекте не было. Теперь есть один интерфейс sendMail, за которым:
 *   - настоящий SMTP, если задан SMTP_HOST;
 *   - иначе прежний вывод в консоль, чтобы локальная разработка не требовала
 *     почтового сервера.
 *
 * Переключение — только через .env, код вызова не меняется.
 */

const nodemailer = require('nodemailer');

const HOST = process.env.SMTP_HOST || '';
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.MAIL_FROM || 'Kaban.gg <no-reply@titanrust.ru>';
const SITE = (process.env.PUBLIC_URL || 'https://titanrust.ru').replace(/\/+$/, '');

let transport = null;
let mode = 'console';

if (HOST) {
  transport = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465,              // 465 — implicit TLS, 587 — STARTTLS
    auth: USER ? { user: USER, pass: PASS } : undefined,
    connectionTimeout: 10000
  });
  mode = 'smtp';
}

/** Проверка настроек — вызывается один раз при старте. */
async function verifyMailer() {
  if (!transport) {
    console.log('[Mail] SMTP не настроен — коды подтверждения пишутся в лог сервера.');
    console.log('       Для реальной отправки задайте SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS.');
    return false;
  }
  try {
    await transport.verify();
    console.log(`[Mail] SMTP готов: ${HOST}:${PORT}, отправитель ${FROM}`);
    return true;
  } catch (e) {
    console.error(`[Mail] SMTP недоступен (${e.message}) — письма будут писаться в лог.`);
    transport = null;
    mode = 'console';
    return false;
  }
}

/**
 * @returns {Promise<{sent: boolean, mode: string}>}
 * Никогда не бросает: сбой почты не должен ронять регистрацию.
 */
async function sendMail({ to, subject, text, html }) {
  if (!transport) {
    console.log(`[Mail:console] -> ${to}\n  ${subject}\n  ${String(text || '').replace(/\n/g, '\n  ')}`);
    return { sent: false, mode: 'console' };
  }
  try {
    await transport.sendMail({ from: FROM, to, subject, text, html: html || undefined });
    console.log(`[Mail] Отправлено на ${to}: ${subject}`);
    return { sent: true, mode: 'smtp' };
  } catch (e) {
    // Падать нельзя: пользователь уже создан, код лежит в базе.
    console.error(`[Mail] Не удалось отправить на ${to}: ${e.message}`);
    console.log(`[Mail:fallback] ${subject}\n  ${text}`);
    return { sent: false, mode: 'error' };
  }
}

// --- Шаблоны ---------------------------------------------------------------

const shell = (title, body) => `<!doctype html><html><body style="margin:0;padding:24px;background:#181614;font-family:Arial,Helvetica,sans-serif;color:#fff">
<div style="max-width:520px;margin:0 auto;background:#22201e;border-radius:16px;padding:28px">
  <h1 style="margin:0 0 16px;font-size:20px;color:#b2ff00">${title}</h1>
  ${body}
  <p style="margin:24px 0 0;font-size:12px;color:#ffffff80">
    Если вы не запрашивали это письмо, просто проигнорируйте его.<br>
    <a href="${SITE}" style="color:#b2ff00">${SITE.replace(/^https?:\/\//, '')}</a>
  </p>
</div></body></html>`;

const codeBlock = (code) => `<p style="margin:0 0 12px;font-size:14px;color:#ffffff80">Код действителен 15 минут:</p>
<div style="font-size:30px;letter-spacing:7px;font-weight:bold;color:#b2ff00;background:#181614;border-radius:12px;padding:16px;text-align:center">${code}</div>`;

function sendVerificationCode(to, code) {
  return sendMail({
    to,
    subject: `Код подтверждения: ${code}`,
    text: `Ваш код подтверждения на Kaban.gg: ${code}\nКод действителен 15 минут.`,
    html: shell('Подтверждение почты', codeBlock(code))
  });
}

function sendPasswordResetCode(to, code) {
  return sendMail({
    to,
    subject: `Код для смены пароля: ${code}`,
    text: `Код для смены пароля на Kaban.gg: ${code}\nКод действителен 15 минут.`,
    html: shell('Смена пароля', codeBlock(code))
  });
}

module.exports = { sendMail, sendVerificationCode, sendPasswordResetCode, verifyMailer, get mode() { return mode; } };
