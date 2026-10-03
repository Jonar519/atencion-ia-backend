// Utilidades comunes de las pruebas de carga (ver loadtests/README.md).
import autocannon from "autocannon";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const API = process.env.LOADTEST_API_URL || "http://localhost:4300";
export const DURATION = Number(process.env.LOADTEST_DURATION || 20);
// Origen permitido por la API de pruebas (CORS_ORIGIN): el WebSocket lo exige.
export const ORIGIN = process.env.LOADTEST_ORIGIN || "http://localhost:5174";
// Contraseña de las cuentas SINTÉTICAS de staff que crea setup.mjs (solo en la base de pruebas).
export const PASSWORD = "Carga-Sintetica-Solo-Pruebas-2026";
// Cuenta de administrador del seed (datos de prueba públicos del repo de base de datos).
export const SEED_ADMIN = { email: "admin@cordillera.example", password: "Password123!" };

const here = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(here, "results");
const STATE_FILE = path.join(here, ".state.json");

export function readState() {
  if (!fs.existsSync(STATE_FILE))
    throw new Error("Falta loadtests/.state.json: corre primero `npm run loadtest:setup`.");
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

export function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function api(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

export async function staffLogin(email, password = PASSWORD) {
  return (await api("POST", "/api/auth/login", { body: { email, password } })).accessToken;
}

/** TOTP de 6 dígitos (RFC 6238, SHA-1, 30 s) para completar el enrolamiento del admin. */
function totp(secret, timeMs = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of secret.replace(/[\s=]/g, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const hmac = crypto.createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/**
 * Login del admin del seed. Desde la Fase 7 un admin necesita verificación en
 * dos pasos: con la base de carga recién preparada (y tras
 * `npm run staff:reset-mfa -- admin@cordillera.example`) el login pide
 * enrolarse, y aquí se completa ese flujo real.
 */
export async function adminLogin({ email, password } = SEED_ADMIN) {
  const first = await api("POST", "/api/auth/login", { body: { email, password } });
  if (first.accessToken) return first.accessToken;
  if (first.mfaRequired) {
    throw new Error(
      "El admin ya tiene MFA en la base de carga: corre antes npm run staff:reset-mfa -- admin@cordillera.example (con DATABASE_URL de la base de carga)."
    );
  }
  const { secret } = await api("POST", "/api/auth/mfa/enroll/start", {
    body: { enrollmentToken: first.enrollmentToken },
  });
  const done = await api("POST", "/api/auth/mfa/enroll/confirm", {
    body: { enrollmentToken: first.enrollmentToken, code: totp(secret) },
  });
  return done.accessToken;
}

/** Percentil exacto (método nearest-rank) de una lista ORDENADA. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? null,
  };
}

/**
 * Corre autocannon registrando la latencia y el código de CADA respuesta
 * (autocannon no reporta p95, y hace falta separar 2xx de 429 y errores).
 */
export function run(name, options) {
  return new Promise((resolve, reject) => {
    const latencies = [];
    const statuses = {};
    const opts = { url: API, ...(options.amount ? {} : { duration: DURATION }), ...options };
    const instance = autocannon(opts, (err, result) => {
      if (err) return reject(err);
      const total = latencies.length;
      const ok = Object.entries(statuses)
        .filter(([code]) => code.startsWith("2"))
        .reduce((sum, [, n]) => sum + n, 0);
      resolve({
        name,
        connections: options.connections,
        durationSeconds: result.duration,
        requests: total,
        throughputRps: Number((total / result.duration).toFixed(1)),
        latencyMs: summarize(latencies),
        statusCodes: statuses,
        socketErrors: result.errors,
        timeouts: result.timeouts,
        errorRate: total + result.errors ? Number((1 - ok / (total + result.errors)).toFixed(4)) : null,
      });
    });
    instance.on("response", (_client, statusCode, _bytes, responseTime) => {
      latencies.push(Number(responseTime.toFixed(1)));
      statuses[statusCode] = (statuses[statusCode] || 0) + 1;
    });
  });
}

export function machine() {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model.trim(),
    logicalCpus: cpus.length,
    ramGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    os: `${os.type()} ${os.release()}`,
    node: process.version,
  };
}

export function save(file, data) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = { measuredAt: new Date().toISOString(), api: API, machine: machine(), ...data };
  fs.writeFileSync(path.join(RESULTS_DIR, file), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
