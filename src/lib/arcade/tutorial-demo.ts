// Canvas demo used by the Arcade tutorial. It is intentionally a plain module:
// the Svelte overlay owns the card, this owns the little 10-second game loop.
import { t } from '../i18n.js';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  r: number;
}

/** Start the demo and return an idempotent cleanup function. */
export function startTutorialDemo(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const w = canvas.width;
  const h = canvas.height;

  let score = 0;
  let timeLeft = 10;
  let gameOver = false;
  let bx = 50;
  let by = 50;
  let bvx = 2;
  let bvy = 1.5;
  let particles: Particle[] = [];
  let animId: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const br = 22;

  const draw = (): void => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${score}`, 10, 22);

    ctx.textAlign = 'right';
    ctx.fillText(`${timeLeft}s`, w - 10, 22);

    if (gameOver) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#22c55e';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText(`Score: ${score}!`, w / 2, h / 2 - 10);
      ctx.fillStyle = '#aaa';
      ctx.font = '13px sans-serif';
      ctx.fillText(t('arcade.tutorial_demo_play_again'), w / 2, h / 2 + 20);
      return;
    }

    for (const p of particles) {
      ctx.globalAlpha = p.life;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = '#22c55e';
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    const gradient = ctx.createRadialGradient(bx - 5, by - 5, 2, bx, by, br);
    gradient.addColorStop(0, '#4ade80');
    gradient.addColorStop(1, '#16a34a');
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(bx - 8, by - 8, 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fill();
  };

  const update = (): void => {
    if (stopped || gameOver) return;
    bx += bvx;
    by += bvy;
    if (bx - br < 0 || bx + br > w) bvx *= -1;
    if (by - br < 0 || by + br > h) bvy *= -1;
    bx = Math.max(br, Math.min(w - br, bx));
    by = Math.max(br, Math.min(h - br, by));

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.02;
      p.r *= 0.98;
    }
    particles = particles.filter((p) => p.life > 0);

    draw();
    animId = requestAnimationFrame(update);
  };

  const popParticles = (x: number, y: number): void => {
    for (let i = 0; i < 12; i += 1) {
      const angle = ((Math.PI * 2) / 12) * i;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * (2 + Math.random() * 3),
        vy: Math.sin(angle) * (2 + Math.random() * 3),
        life: 1,
        r: 3 + Math.random() * 3,
      });
    }
  };

  const handleClick = (event: MouseEvent | TouchEvent): void => {
    if (gameOver) {
      score = 0;
      timeLeft = 10;
      gameOver = false;
      particles = [];
      bx = 50 + Math.random() * (w - 100);
      by = 50 + Math.random() * (h - 100);
      startTimer();
      update();
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = w / rect.width;
    const scaleY = h / rect.height;
    const point = 'touches' in event ? event.touches[0] : event;
    if (!point) return;
    const cx = (point.clientX - rect.left) * scaleX;
    const cy = (point.clientY - rect.top) * scaleY;
    if (Math.hypot(cx - bx, cy - by) < br) {
      score += 1;
      popParticles(bx, by);
      bx = 30 + Math.random() * (w - 60);
      by = 30 + Math.random() * (h - 60);
    }
  };

  canvas.addEventListener('click', handleClick);
  canvas.addEventListener('touchstart', handleClick, { passive: true });
  update();
  startTimer();

  function startTimer(): void {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => {
      if (timeLeft > 0) {
        timeLeft -= 1;
        return;
      }
      gameOver = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      draw();
    }, 1000);
  }

  return () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    if (animId !== null) cancelAnimationFrame(animId);
    canvas.removeEventListener('click', handleClick);
    canvas.removeEventListener('touchstart', handleClick);
  };
}
