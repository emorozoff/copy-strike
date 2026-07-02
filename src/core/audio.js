// WebAudio: браузер требует пользовательский жест до звука — init() зовём по
// первому клику («ИГРАТЬ»), до этого play() молча ничего не делает.
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = new Map();
    this.pending = null; // {name: url} — что загрузить после появления ctx
    // AudioContext можно создать ДО жеста (будет suspended) — тогда буферы
    // декодируются заранее и первый выстрел после «ИГРАТЬ» не будет немым
    this.createContext();
  }

  createContext() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
    } catch { this.ctx = null; }
    if (this.ctx && this.pending) { this.loadAll(this.pending); this.pending = null; }
  }

  init() {
    this.createContext();
    this.unlock();
  }

  unlock() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  // можно звать до init — файлы загрузятся при первом жесте
  loadAll(nameToUrl) {
    if (!this.ctx) { this.pending = { ...(this.pending || {}), ...nameToUrl }; return; }
    for (const [name, url] of Object.entries(nameToUrl)) {
      fetch(url)
        .then(r => r.arrayBuffer())
        .then(ab => this.ctx.decodeAudioData(ab))
        .then(buf => this.buffers.set(name, buf))
        .catch(err => console.warn('звук не загрузился:', name, err.message));
    }
  }

  play(name, { volume = 1, rate = 1, delay = 0 } = {}) {
    const buf = this.buffers.get(name);
    if (!buf || !this.ctx || this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(this.master);
    src.start(this.ctx.currentTime + delay);
  }

  playOneOf(names, opts) {
    this.play(names[Math.floor(Math.random() * names.length)], opts);
  }
}
