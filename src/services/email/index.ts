import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";

/**
 * Correo saliente, detrás de una interfaz (mismo patrón que la IA y la voz):
 *  - "mock" (por defecto): NO envía nada; guarda el mensaje en la tabla
 *    email_outbox para leerlo con psql (docs/demo-fase7.md). Prohibido en producción.
 *  - "smtp": envía por SMTP (SMTP_URL, p. ej. smtps://usuario:clave@smtp.proveedor.com:465),
 *    con nodemailer. Se activa solo cuando se cargan credenciales reales.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Plantilla usada (para la bandeja simulada y los logs, nunca el contenido). */
  template: string;
  relatedStaffId?: string | null;
}

export interface EmailProvider {
  readonly provider: "mock" | "smtp";
  send(message: EmailMessage): Promise<void>;
}

export function createMockEmail(): EmailProvider {
  return {
    provider: "mock",
    async send(message) {
      await prisma.emailOutbox.create({
        data: {
          toAddress: message.to,
          subject: message.subject.slice(0, 200),
          bodyText: message.text,
          template: message.template,
          relatedStaffId: message.relatedStaffId ?? null,
        },
      });
    },
  };
}

/** El transporte se inyecta: los tests prueban el adaptador con un doble, sin red. */
export function createSmtpEmail(options: { from: string; transport: Pick<Transporter, "sendMail"> }): EmailProvider {
  return {
    provider: "smtp",
    async send(message) {
      await options.transport.sendMail({
        from: options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

let current: EmailProvider | null = null;

export function getEmail(): EmailProvider {
  current ??=
    env.email.provider === "smtp"
      ? createSmtpEmail({ from: env.email.from, transport: nodemailer.createTransport(env.email.smtpUrl!) })
      : createMockEmail();
  return current;
}

/** Solo tests. null = volver al configurado. */
export function setEmailForTests(provider: EmailProvider | null) {
  current = provider;
}
