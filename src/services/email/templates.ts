import { env } from "../../config/env";
import type { EmailMessage } from "./index";

/**
 * Plantillas de correo (texto plano: sin HTML, no hay nada que inyectar).
 * Los enlaces llevan el token en el FRAGMENTO (#…): el navegador no lo envía
 * al servidor ni lo deja en logs de acceso ni en el Referer.
 */
const link = (route: string, token: string) =>
  `${env.identity.appBaseUrl}/#/agente/${route}?token=${encodeURIComponent(token)}`;

const FOOTER =
  "\n\nSi no fuiste tú, ignora este mensaje y avisa a un administrador.\n— Banco Cordillera, atención al cliente";

export const templates = {
  passwordReset(to: string, staffId: string, token: string): EmailMessage {
    return {
      to,
      relatedStaffId: staffId,
      template: "password_reset",
      subject: "Restablece tu contraseña",
      text: `Pediste restablecer tu contraseña del panel de asesores.\n\nAbre este enlace (vence en 15 minutos y sirve una sola vez):\n${link("restablecer", token)}${FOOTER}`,
    };
  },
  passwordChanged(to: string, staffId: string): EmailMessage {
    return {
      to,
      relatedStaffId: staffId,
      template: "password_changed",
      subject: "Tu contraseña cambió",
      text: `La contraseña de tu cuenta del panel de asesores acaba de cambiar y se cerraron tus otras sesiones.${FOOTER}`,
    };
  },
  emailChangeVerify(to: string, staffId: string, token: string): EmailMessage {
    return {
      to,
      relatedStaffId: staffId,
      template: "email_change_verify",
      subject: "Confirma tu nuevo correo",
      text: `Pediste usar este correo en tu cuenta del panel de asesores.\n\nConfírmalo con este enlace (vence en 15 minutos):\n${link("confirmar-correo", token)}${FOOTER}`,
    };
  },
  emailChangeNotice(to: string, staffId: string, newEmail: string): EmailMessage {
    // Al correo ANTERIOR: si alguien tomó la cuenta, la persona se entera.
    const masked = newEmail.replace(/^(.)[^@]*(@.*)$/, "$1***$2");
    return {
      to,
      relatedStaffId: staffId,
      template: "email_change_notice",
      subject: "Se pidió cambiar el correo de tu cuenta",
      text: `Se pidió cambiar el correo de tu cuenta a ${masked}. El cambio solo se aplica si se confirma desde ese correo.${FOOTER}`,
    };
  },
  mfaChanged(to: string, staffId: string, enabled: boolean): EmailMessage {
    return {
      to,
      relatedStaffId: staffId,
      template: enabled ? "mfa_enabled" : "mfa_disabled",
      subject: enabled ? "Activaste la verificación en dos pasos" : "Desactivaste la verificación en dos pasos",
      text: `La verificación en dos pasos de tu cuenta quedó ${enabled ? "ACTIVADA" : "DESACTIVADA"}.${FOOTER}`,
    };
  },
};
