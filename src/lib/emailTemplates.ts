// ── Email templates ──────────────────────────────────────────────────────────
// Inline styles only: every mail client strips <style> blocks. Colors come from
// the same palette as the web app (white surface, black text, wine accent).

import { config } from "../config.ts";

const WINE = "#7b1230";
const INK = "#111111";
const MUTED = "#5a5a5a";
const HAIRLINE = "#e4e4e4";

function shell(heading: string, inner: string): string {
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:24px;background:#f4f4f4;font-family:Helvetica,Arial,sans-serif;color:${INK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid ${HAIRLINE};border-radius:14px;">
    <tr><td style="padding:28px 28px 8px 28px;">
      <div style="font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:${WINE};font-weight:700;">${config.appName}</div>
      <h1 style="margin:14px 0 0 0;font-size:22px;line-height:1.25;font-weight:700;color:${INK};">${heading}</h1>
    </td></tr>
    <tr><td style="padding:12px 28px 28px 28px;">${inner}</td></tr>
    <tr><td style="padding:0 28px 24px 28px;border-top:1px solid ${HAIRLINE};">
      <p style="margin:16px 0 0 0;font-size:12px;line-height:1.6;color:${MUTED};">
        Si usted no pidió este correo, puede ignorarlo. Nadie puede entrar a su cuenta sin este código.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

export function otpEmail(code: string, minutes: number): {
  subject: string;
  html: string;
  text: string;
} {
  const inner = `
    <p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;color:${INK};">
      Escriba este código para entrar:
    </p>
    <div style="font-size:34px;letter-spacing:.34em;font-weight:700;color:${WINE};padding:14px 0;">${code}</div>
    <p style="margin:14px 0 0 0;font-size:14px;line-height:1.6;color:${MUTED};">
      El código vence en ${minutes} minutos.
    </p>`;

  return {
    subject: `${code} es su código de ${config.appName}`,
    html: shell("Su código de acceso", inner),
    text:
      `Su código de acceso a ${config.appName} es ${code}. Vence en ${minutes} minutos.\n\nSi usted no pidió este correo, puede ignorarlo.`,
  };
}

export function editorInviteEmail(grantedBy: string): {
  subject: string;
  html: string;
  text: string;
} {
  const inner = `
    <p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:${INK};">
      ${grantedBy} le dio acceso de editor en ${config.appName}. Ya puede escribir y corregir los artículos que le asignen.
    </p>
    <p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:${INK};">
      Entre con su correo. El sistema le manda un código cada vez.
    </p>
    <a href="${config.appBaseUrl}/admin" style="display:inline-block;background:${WINE};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:999px;">Abrir el panel</a>`;

  return {
    subject: `Ya puede editar en ${config.appName}`,
    html: shell("Acceso de editor", inner),
    text:
      `${grantedBy} le dio acceso de editor en ${config.appName}. Entre en ${config.appBaseUrl}/admin con su correo; el sistema le manda un código cada vez.`,
  };
}
