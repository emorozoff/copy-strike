// Лобби: комната Trystero (Nostr-сигналинг) по короткому коду.
// Хост создаёт код, гость вводит его; соединение WebRTC P2P.
// API trystero 0.25: makeAction → объект {send, onMessage=сеттер},
// onPeerJoin/onPeerLeave — свойства-сеттеры (проверено в net-test.html).
import { joinRoom, selfId } from '../../vendor/trystero-nostr.mjs';

// STUN пачкой, включая российский — Google из РФ под риском блокировки
const ICE = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.sipnet.ru:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.nextcloud.com:443' },
] };

// без похожих символов (O/0, I/1/L)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeCode(len = 5) {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return [...buf].map(v => CODE_ALPHABET[v % CODE_ALPHABET.length]).join('');
}

export function normalizeCode(raw) {
  return raw.toUpperCase().split('').filter(c => CODE_ALPHABET.includes(c)).join('').slice(0, 5);
}

export class Lobby {
  constructor() {
    this.room = null;
    this.code = null;
    this.isHost = false;
    this.peerId = null;
    this.rtt = null;
    this.onPeer = null;   // (connected: boolean) => void
    this.onStart = null;  // () => void — хост скомандовал старт
    this.onSnap = null;   // (data, peerId) => void — снапшот состояния соперника
    this._pingTimer = null;
    this._startAction = null;
    this._snapAction = null;
  }

  get connected() { return !!this.peerId; }

  join(code, isHost) {
    this.leave();
    this.code = code;
    this.isHost = isHost;
    this.room = joinRoom({ appId: 'copy-strike', password: 'cs-' + code, rtcConfig: ICE }, code);

    this._startAction = this.room.makeAction('start');
    this._startAction.onMessage = () => { if (!this.isHost) this.onStart?.(); };

    // Канал снапшотов игрока (позиция/поворот/состояние). Пока обычный
    // Trystero-action (надёжный, упорядоченный); на устойчивость под потерями
    // (ручной unreliable-канал) заложен шаг 10.
    this._snapAction = this.room.makeAction('snap');
    this._snapAction.onMessage = (data, peerId) => this.onSnap?.(data, peerId);

    this.room.onPeerJoin = id => {
      this.peerId = id;
      this._startPing();
      this.onPeer?.(true);
    };
    this.room.onPeerLeave = id => {
      if (id !== this.peerId) return;
      this.peerId = null;
      this._stopPing();
      this.onPeer?.(false);
    };
  }

  sendStart() { this._startAction?.send({ go: 1 }); }

  // Снапшот шлём соседу как есть (компактный массив чисел). В 1v1 — всем пирам.
  sendSnap(data) { this._snapAction?.send(data); }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(async () => {
      if (!this.peerId || !this.room) return;
      try { this.rtt = await this.room.ping(this.peerId); } catch { /* пир мог уйти между тиками */ }
    }, 1000);
  }

  _stopPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
    this.rtt = null;
  }

  leave() {
    this._stopPing();
    try { this.room?.leave(); } catch { /* соединение могло уже умереть */ }
    this.room = null;
    this.peerId = null;
    this.code = null;
    this._startAction = null;
    this._snapAction = null;
  }
}

export { selfId };
