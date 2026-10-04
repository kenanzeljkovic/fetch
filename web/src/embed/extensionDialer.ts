/**
 * ExtensionDialer — the only Dialer the embed uses. Telnyx runs in the extension's offscreen
 * document (FETCH_INIT.dialerHost === 'extension'); every call goes iframe → content script →
 * background → offscreen, so the microphone belongs to the extension and this cross-origin iframe
 * never touches WebRTC. Older extensions don't send dialerHost, and EmbedApp refuses to dial for them.
 */
import type { DialEvent, Dialer } from '../lib/dialer';
import { onParentMessage, sendToParent, type DialerOp } from './embedBridge';

// connect covers Telnyx's own 15s login timeout; dial may have to connect first.
const TIMEOUT_MS: Record<DialerOp, number> = { connect: 20000, dial: 30000, hangup: 5000 };

interface Result { callerNumber?: string; mock?: boolean }

export class ExtensionDialer implements Dialer {
  callerNumber = '';
  mock = false;
  private seq = 0;
  private pending = new Map<string, { resolve: (r: Result) => void; reject: (e: Error) => void; timer: number }>();
  private onEvent: ((e: DialEvent) => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private off: () => void;

  constructor() {
    this.off = onParentMessage((m) => {
      if (m.type === 'FETCH_DIALER_RESULT') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        window.clearTimeout(p.timer);
        if (m.ok) p.resolve(m);
        else p.reject(new Error(m.error || 'The Fetch extension could not do that.'));
      } else if (m.type === 'FETCH_DIALER_EVENT') {
        if (m.event && typeof m.event.state === 'string') this.onEvent?.(m.event);
      }
    });
  }

  private request(op: DialerOp, destinationNumber?: string, callerNumber?: string): Promise<Result> {
    const id = `${op}-${++this.seq}`;
    return new Promise<Result>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The Fetch extension did not answer. Reload this tab and try again.'));
      }, TIMEOUT_MS[op]);
      this.pending.set(id, { resolve, reject, timer });
      sendToParent({ type: 'FETCH_DIALER', id, op, destinationNumber, callerNumber });
    });
  }

  ready(): Promise<void> {
    if (!this.readyPromise) {
      const p = this.request('connect').then((r) => {
        this.callerNumber = r.callerNumber || '';
        this.mock = !!r.mock;
      });
      p.catch(() => { if (this.readyPromise === p) this.readyPromise = null; });
      this.readyPromise = p;
    }
    return this.readyPromise;
  }

  async dial(destinationNumber: string, onEvent: (e: DialEvent) => void, callerNumber?: string) {
    this.onEvent = onEvent;
    await this.ready();
    await this.request('dial', destinationNumber, callerNumber);
  }

  async hangup() {
    await this.request('hangup');
  }

  destroy() {
    this.off();
    for (const p of this.pending.values()) { window.clearTimeout(p.timer); p.reject(new Error('Dialer closed.')); }
    this.pending.clear();
    this.onEvent = null;
  }
}
