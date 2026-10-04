/**
 * Embed bridge — the iframe side of the extension ↔ app protocol.
 * Drop into web/src/embed/embedBridge.ts.
 *
 * The app runs in "embed mode" when loaded at /?embed=1 inside the Fetch extension's iframe.
 * The parent (Twenty's page) is identified by location.ancestorOrigins, and every inbound
 * message is checked against that origin. The server's Content-Security-Policy
 * (frame-ancestors) is what decides which sites may frame the app at all.
 */

import type { DialEvent } from '../lib/dialer';

export type CallState = 'idle' | 'checking' | 'blocked' | 'dialing' | 'ringing' | 'connected' | 'ended';

/** Where Telnyx runs. Only 'extension' (the offscreen document) can place calls; 'page' marks an extension too old to host it. */
export type DialerHost = 'extension' | 'page';
export type DialerOp = 'connect' | 'dial' | 'hangup';

export interface EmbedContactRef {
  objectType: 'person' | 'company';
  recordId: string;      // Twenty record id taken from the page URL — the only thing logging trusts
  name?: string;         // display only; the server re-reads the record by id
  company?: string;
}

export type ParentToEmbed =
  | { type: 'FETCH_INIT'; repEmail: string; theme: 'light' | 'dark'; twentyOrigin: string; dialerHost?: DialerHost; defaultCallerId?: string }
  | { type: 'FETCH_DIAL'; phone: string; contact: EmbedContactRef | null }
  | { type: 'FETCH_THEME'; theme: 'light' | 'dark' }
  | { type: 'FETCH_OPEN'; view: 'call' | 'manual' }
  | { type: 'FETCH_DIALER_RESULT'; id: string; ok: boolean; error?: string; callerNumber?: string; mock?: boolean }
  | { type: 'FETCH_DIALER_EVENT'; event: DialEvent };

export type EmbedToParent =
  | { type: 'FETCH_READY' }
  | { type: 'FETCH_STATE'; state: CallState; seconds: number; contactName: string }
  | { type: 'FETCH_MINIMIZE' }
  | { type: 'FETCH_CLOSE' }
  | { type: 'FETCH_DIALER'; id: string; op: DialerOp; destinationNumber?: string; callerNumber?: string };

export function isEmbedded(): boolean {
  return new URLSearchParams(window.location.search).get('embed') === '1' && window.parent !== window;
}

export function parentOrigin(): string | null {
  const a = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (a && a.length) return a[0];
  try { return document.referrer ? new URL(document.referrer).origin : null; } catch { return null; }
}

export function sendToParent(msg: EmbedToParent): void {
  const origin = parentOrigin();
  if (!origin || window.parent === window) return;
  window.parent.postMessage(msg, origin);
}

export function onParentMessage(handler: (msg: ParentToEmbed) => void): () => void {
  const listener = (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    if (e.origin !== parentOrigin()) return;
    const m = e.data as ParentToEmbed | undefined;
    if (!m || typeof m.type !== 'string' || !m.type.startsWith('FETCH_')) return;
    handler(m);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
