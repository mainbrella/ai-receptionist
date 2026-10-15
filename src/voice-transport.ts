import type { VoiceTransport, VoiceTransportCloseInfo } from '@cloudflare/voice/client';

/** Each test owns one connection. Reconnecting would risk replaying an utterance. */
export class CallTransport implements VoiceTransport {
  onopen: (() => void) | null = null;
  onclose: ((info?: VoiceTransportCloseInfo) => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;
  private socket: WebSocket | null = null;

  constructor(private readonly url: string) {}

  get connected() { return this.socket?.readyState === WebSocket.OPEN; }

  connect() {
    if (this.socket) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => this.onopen?.();
    socket.onmessage = event => this.onmessage?.(event.data);
    socket.onerror = event => this.onerror?.(event);
    socket.onclose = event => {
      this.socket = null;
      this.onclose?.({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    };
  }

  sendJSON(data: Record<string, unknown>) {
    if (this.connected) this.socket!.send(JSON.stringify(data));
  }

  sendBinary(data: ArrayBuffer) {
    if (this.connected) this.socket!.send(data);
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close(1000, 'Test ended');
  }
}
