/**
 * Proteção local por senha (SPA estática): PBKDF2 + AES-GCM no localStorage.
 * Limitação: não substitui servidor; alguém com acesso ao JS/dispositivo pode contornar com esforço.
 */

export const FINANCE_STORAGE_KEY = 'finance_flow_local_v1';

const AUTH_META_KEY = 'sculacho_auth_meta_v1';
const SESSION_KEY_B64 = 'sculacho_sk_v1';

export interface AuthMeta {
  salt: string;
  verifier: string;
}

function b64FromBytes(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
}

function bytesFromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hasPasswordProtection(): boolean {
  return !!localStorage.getItem(AUTH_META_KEY);
}

export function readAuthMeta(): AuthMeta | null {
  const raw = localStorage.getItem(AUTH_META_KEY);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as AuthMeta;
    if (typeof o.salt !== 'string' || typeof o.verifier !== 'string') return null;
    return o;
  } catch {
    return null;
  }
}

async function deriveKeyMaterial(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
}

async function sha256Buffer(buf: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', buf);
}

export async function verifyPasswordAndStoreSession(password: string): Promise<boolean> {
  const meta = readAuthMeta();
  if (!meta) return true;
  const salt = bytesFromB64(meta.salt);
  const bits = await deriveKeyMaterial(password, salt);
  const digest = await sha256Buffer(bits);
  if (b64FromBytes(new Uint8Array(digest)) !== meta.verifier) return false;
  sessionStorage.setItem(SESSION_KEY_B64, b64FromBytes(new Uint8Array(bits)));
  return true;
}

/** Material derivado guardado só nesta aba (sessionStorage). */
export function getSessionKeyMaterial(): ArrayBuffer | null {
  const s = sessionStorage.getItem(SESSION_KEY_B64);
  if (!s) return null;
  const u8 = bytesFromB64(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

export function clearSessionAuth(): void {
  sessionStorage.removeItem(SESSION_KEY_B64);
}

export async function encryptPlaintext(
  plaintext: string,
  keyMaterial: ArrayBuffer
): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'AES-GCM', false, ['encrypt']);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return {
    iv: b64FromBytes(iv),
    data: b64FromBytes(new Uint8Array(ciphertext)),
  };
}

export async function decryptToPlaintext(
  ivB64: string,
  dataB64: string,
  keyMaterial: ArrayBuffer
): Promise<string> {
  const iv = bytesFromB64(ivB64);
  const ct = bytesFromB64(dataB64);
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'AES-GCM', false, ['decrypt']);
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(buf);
}

export async function createAuthAndEncryptFirstTime(password: string, plainStateJson: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveKeyMaterial(password, salt);
  const digest = await sha256Buffer(bits);
  const meta: AuthMeta = {
    salt: b64FromBytes(salt),
    verifier: b64FromBytes(new Uint8Array(digest)),
  };
  localStorage.setItem(AUTH_META_KEY, JSON.stringify(meta));
  const { iv, data } = await encryptPlaintext(plainStateJson, bits);
  localStorage.setItem(FINANCE_STORAGE_KEY, JSON.stringify({ _enc: 'v1', iv, data }));
  sessionStorage.setItem(SESSION_KEY_B64, b64FromBytes(new Uint8Array(bits)));
}

/** Remove proteção: valida senha, grava JSON em claro e apaga meta. Limpa sessão. */
export async function removePasswordProtection(
  password: string
): Promise<{ ok: true; plainJson: string } | { ok: false; reason: 'senha' | 'dados' }> {
  const meta = readAuthMeta();
  if (!meta) return { ok: false, reason: 'dados' };
  const salt = bytesFromB64(meta.salt);
  const bits = await deriveKeyMaterial(password, salt);
  const digest = await sha256Buffer(bits);
  if (b64FromBytes(new Uint8Array(digest)) !== meta.verifier) return { ok: false, reason: 'senha' };

  const raw = localStorage.getItem(FINANCE_STORAGE_KEY);
  if (!raw) return { ok: false, reason: 'dados' };
  let plainJson: string;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed._enc === 'v1' && typeof parsed.iv === 'string' && typeof parsed.data === 'string') {
      plainJson = await decryptToPlaintext(parsed.iv, parsed.data, bits);
    } else {
      plainJson = raw;
    }
  } catch {
    return { ok: false, reason: 'dados' };
  }

  localStorage.removeItem(AUTH_META_KEY);
  localStorage.setItem(FINANCE_STORAGE_KEY, plainJson);
  clearSessionAuth();
  return { ok: true, plainJson };
}
