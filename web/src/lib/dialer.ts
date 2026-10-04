/**
 * Dialer abstraction. TelnyxDialer is the real thing (Telnyx WebRTC JS SDK).
 * MockDialer simulates the same state machine for UI testing when the server
 * runs with MOCK_MODE=true. Nothing else in the app knows which one it has.
 */
import { TelnyxRTC } from '@telnyx/webrtc';

export type DialState = 'idle' | 'connecting' | 'calling' | 'connected' | 'ended' | 'failed' | 'blocked';

export interface DialEvent {
  state: DialState;
  telnyxCallId?: string | null;
  error?: string;
  /** true when the call ended without the remote party ever answering */
  neverConnected?: boolean;
}

export interface Dialer {
  /** Connects/authenticates. Resolves when calls can be placed. */
  ready(): Promise<void>;
  /** callerNumber overrides the connection's default caller ID for this call only. */
  dial(destinationNumber: string, onEvent: (e: DialEvent) => void, callerNumber?: string): Promise<void>;
  hangup(): Promise<void>;
  destroy(): void;
}

// Telnyx call.state values that mean "ringing / not answered yet"
const CALLING_STATES = new Set(['new', 'trying', 'requesting', 'recovering', 'ringing', 'answering', 'early']);
const ENDED_STATES = new Set(['hangup', 'destroy', 'purge']);

export class TelnyxDialer implements Dialer {
  private client: TelnyxRTC;
  private call: any = null;
  private readyPromise: Promise<void> | null = null;
  private onEvent: ((e: DialEvent) => void) | null = null;
  private wasActive = false;

  constructor(loginToken: string, private callerNumber: string) {
    this.client = new TelnyxRTC({ login_token: loginToken });
    // The SDK routes the far end's audio into this element (see index.html)
    (this.client as any).remoteElement = 'remoteAudio';
  }

  ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting to Telnyx. Check TELNYX_CONNECTION_ID and your network.')), 15000);
      this.client.on('telnyx.ready', () => { clearTimeout(timeout); resolve(); });
      this.client.on('telnyx.error', (err: any) => {
        clearTimeout(timeout);
        const msg = err?.message || err?.error?.message || 'Telnyx authentication failed.';
        this.onEvent?.({ state: 'failed', error: msg });
        reject(new Error(msg));
      });
      this.client.on('telnyx.socket.close', () => {
        if (this.call) this.onEvent?.({ state: 'failed', error: 'Lost the connection to Telnyx.' });
      });
      this.client.on('telnyx.notification', (n: any) => this.handleNotification(n));
      this.client.connect();
    });
    return this.readyPromise;
  }

  private handleNotification(n: any) {
    if (n?.type === 'userMediaError') {
      this.onEvent?.({ state: 'failed', error: 'Microphone access was denied. Allow the microphone in your browser and try again.' });
      return;
    }
    if (n?.type !== 'callUpdate' || !n.call) return;
    const call = n.call;
    if (this.call && call.id !== this.call.id && !call.recoveredCallId) return; // not our call
    this.call = call;
    const telnyxCallId = call?.telnyxIDs?.telnyxCallControlId || call?.telnyxIDs?.telnyxCallId || call?.id || null;
    const state: string = call.state;

    if (CALLING_STATES.has(state)) {
      this.onEvent?.({ state: 'calling', telnyxCallId });
    } else if (state === 'active') {
      this.wasActive = true;
      this.onEvent?.({ state: 'connected', telnyxCallId });
    } else if (ENDED_STATES.has(state)) {
      const cause: string = call.cause || '';
      const neverConnected = !this.wasActive;
      // Distinguish a hard failure from an ordinary hangup / no answer
      const failed = /INVALID|FORBIDDEN|UNALLOCATED|NETWORK|BEARER|INCOMPATIBLE|CALL_REJECTED|REQUEST_TIMEOUT/i.test(cause) && neverConnected;
      this.onEvent?.({ state: failed ? 'failed' : 'ended', telnyxCallId, neverConnected, error: failed ? `Telnyx could not complete the call (${cause}).` : undefined });
      this.call = null;
      this.wasActive = false;
    }
  }

  async dial(destinationNumber: string, onEvent: (e: DialEvent) => void, callerNumber?: string) {
    this.onEvent = onEvent;
    this.wasActive = false;
    await this.ready();
    // Ask for the microphone up front so a denial is a clear error, not a silent dead call
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error('Microphone access was denied. Allow the microphone in your browser and try again.');
    }
    onEvent({ state: 'calling' });
    this.call = this.client.newCall({ destinationNumber, callerNumber: callerNumber || this.callerNumber, audio: true, video: false } as any);
  }

  async hangup() {
    try { await this.call?.hangup?.(); } catch { /* already gone */ }
  }

  destroy() {
    try { this.client.disconnect(); } catch { /* ignore */ }
    this.client.off('telnyx.ready');
    this.client.off('telnyx.error');
    this.client.off('telnyx.notification');
    this.client.off('telnyx.socket.close');
  }
}

/** MOCK — only when the server reports mode === 'mock'. Never used in production. */
export class MockDialer implements Dialer {
  private timers: number[] = [];
  private onEvent: ((e: DialEvent) => void) | null = null;
  private connected = false;

  async ready() { /* nothing to connect */ }

  async dial(destinationNumber: string, onEvent: (e: DialEvent) => void) {
    this.onEvent = onEvent;
    this.connected = false;
    const fakeId = `mock-call-${Math.random().toString(36).slice(2, 10)}`;
    onEvent({ state: 'calling', telnyxCallId: fakeId });
    // Numbers ending in 0199 simulate "no answer"; everything else connects after ~2s
    if (destinationNumber.endsWith('0199')) {
      this.timers.push(window.setTimeout(() => onEvent({ state: 'ended', telnyxCallId: fakeId, neverConnected: true }), 4000));
    } else {
      this.timers.push(window.setTimeout(() => { this.connected = true; onEvent({ state: 'connected', telnyxCallId: fakeId }); }, 2000));
    }
  }

  async hangup() {
    this.timers.forEach(clearTimeout);
    this.onEvent?.({ state: 'ended', neverConnected: !this.connected });
  }

  destroy() { this.timers.forEach(clearTimeout); }
}
