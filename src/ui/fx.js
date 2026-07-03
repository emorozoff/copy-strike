// Атмосфера меню на 2D-канвасе: лучи света, клубы дыма у земли, пыль в воздухе.
// Лёгкий параллакс за мышью. Работает только пока меню видно (start/stop).

function makeBlobSprite(size, inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export class MenuFx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.running = false;
    this.t = 0;
    this.mx = 0; // параллакс от мыши, -1..1
    this.my = 0;

    this.smokeSprite = makeBlobSprite(256, 'rgba(190,170,140,0.16)', 'rgba(190,170,140,0)');
    this.dustSprite = makeBlobSprite(32, 'rgba(255,238,200,0.9)', 'rgba(255,238,200,0)');

    this.dust = Array.from({ length: 46 }, () => this.spawnDust(true));
    this.smoke = Array.from({ length: 7 }, (_, i) => this.spawnSmoke(i / 7));

    addEventListener('mousemove', e => {
      this.mx = (e.clientX / innerWidth) * 2 - 1;
      this.my = (e.clientY / innerHeight) * 2 - 1;
    });
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    this.canvas.width = innerWidth;
    this.canvas.height = innerHeight;
  }

  spawnDust(anywhere) {
    return {
      x: Math.random(), y: anywhere ? Math.random() : -0.02,
      z: 0.3 + Math.random() * 0.7,             // «глубина» — размер/скорость/параллакс
      vx: (Math.random() - 0.3) * 0.008,
      vy: 0.004 + Math.random() * 0.012,
      ph: Math.random() * Math.PI * 2,          // фаза мерцания
    };
  }

  spawnSmoke(seed) {
    return {
      x: Math.random(), y: 0.66 + Math.random() * 0.3,
      s: 0.35 + Math.random() * 0.55,           // размер в долях экрана
      vx: 0.004 + Math.random() * 0.01,
      ph: (seed ?? Math.random()) * Math.PI * 2,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;
      this.draw(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(dt) {
    const { ctx, canvas: cv, t } = this;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const px = this.mx * 14, py = this.my * 8; // параллакс, пиксели

    // лучи света: две наклонные полосы, медленно «дышат»
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [ox, w, ph] of [[0.22, 0.13, 0], [0.55, 0.09, 2.1]]) {
      const a = 0.05 + 0.03 * Math.sin(t * 0.35 + ph);
      const x0 = ox * W - px * 2;
      ctx.save();
      ctx.translate(x0, -H * 0.1);
      ctx.rotate(0.3);
      const grad = ctx.createLinearGradient(0, 0, w * W, 0);
      grad.addColorStop(0, 'rgba(255,225,160,0)');
      grad.addColorStop(0.5, `rgba(255,225,160,${a})`);
      grad.addColorStop(1, 'rgba(255,225,160,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w * W, H * 1.6);
      ctx.restore();
    }
    ctx.restore();

    // дым у земли: большие мягкие блобы плывут вбок
    for (const s of this.smoke) {
      s.x += s.vx * dt;
      if (s.x > 1.25) { Object.assign(s, this.spawnSmoke(), { x: -0.25 }); }
      const wob = Math.sin(t * 0.25 + s.ph) * 0.015;
      const size = s.s * W * 0.5;
      ctx.globalAlpha = 0.75 + 0.25 * Math.sin(t * 0.2 + s.ph * 2);
      ctx.drawImage(this.smokeSprite,
        s.x * W - size / 2 - px * 1.6, (s.y + wob) * H - size / 2 - py * 1.6, size, size);
    }
    ctx.globalAlpha = 1;

    // пыль: мелкие светящиеся точки, всплывают и мерцают
    for (const d of this.dust) {
      d.x += d.vx * dt * d.z;
      d.y -= d.vy * dt * d.z;
      if (d.y < -0.03 || d.x < -0.03 || d.x > 1.03) Object.assign(d, this.spawnDust(false), { y: 1.02 });
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * (1.2 + d.z) + d.ph));
      const size = 1.5 + 3.5 * d.z;
      ctx.globalAlpha = tw * 0.5;
      ctx.drawImage(this.dustSprite,
        d.x * W - size / 2 - px * d.z, d.y * H - size / 2 - py * d.z, size, size);
    }
    ctx.globalAlpha = 1;
  }
}
