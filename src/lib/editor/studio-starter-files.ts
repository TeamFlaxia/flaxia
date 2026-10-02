export const STUDIO_STARTER_TEMPLATES = [
  {
    id: 'html-game',
    label: 'Interactive HTML game',
    extension: '.html',
    defaultName: 'my-game',
    mimeType: 'text/html',
  },
  {
    id: 'javascript',
    label: 'JavaScript source',
    extension: '.js',
    defaultName: 'script',
    mimeType: 'text/javascript',
  },
  {
    id: 'typescript',
    label: 'TypeScript source',
    extension: '.ts',
    defaultName: 'script',
    mimeType: 'text/typescript',
  },
  { id: 'css', label: 'Stylesheet', extension: '.css', defaultName: 'styles', mimeType: 'text/css' },
  { id: 'json', label: 'JSON data', extension: '.json', defaultName: 'data', mimeType: 'application/json' },
] as const;

export type StudioStarterTemplateId = (typeof STUDIO_STARTER_TEMPLATES)[number]['id'];

const HTML_GAME_STARTER = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Catch the star</title>
    <style>
      * { box-sizing: border-box; }
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #101522; color: #eaf0ff; font: 16px system-ui, sans-serif; }
      main { width: min(92vw, 680px); }
      header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
      h1 { margin: 0 0 12px; font-size: 20px; }
      #score { color: #b8ef6a; font-variant-numeric: tabular-nums; }
      canvas { display: block; width: 100%; border: 1px solid #39445b; border-radius: 10px; background: #151d2d; touch-action: none; }
      p { margin: 10px 0 0; color: #abb6cc; font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <header><h1>Catch the star</h1><strong id="score">Stars: 0</strong></header>
      <canvas id="game" width="640" height="360" aria-label="Game area"></canvas>
      <p>Move with arrow keys or WASD. Click or tap to move the player. Catch the star!</p>
    </main>
    <script>
      const canvas = document.querySelector('#game');
      const context = canvas.getContext('2d');
      const scoreLabel = document.querySelector('#score');
      const player = { x: 80, y: 180, radius: 13, speed: 4 };
      const star = { x: 440, y: 180, radius: 10 };
      const keys = new Set();
      let score = 0;

      window.addEventListener('keydown', (event) => {
        const key = event.key.toLowerCase();
        if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(key)) {
          event.preventDefault();
          keys.add(key);
        }
      });
      window.addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
      canvas.addEventListener('pointerdown', (event) => {
        const bounds = canvas.getBoundingClientRect();
        player.x = ((event.clientX - bounds.left) / bounds.width) * canvas.width;
        player.y = ((event.clientY - bounds.top) / bounds.height) * canvas.height;
      });

      function placeStar() {
        star.x = 24 + Math.random() * (canvas.width - 48);
        star.y = 24 + Math.random() * (canvas.height - 48);
      }

      function frame() {
        if (keys.has('arrowleft') || keys.has('a')) player.x -= player.speed;
        if (keys.has('arrowright') || keys.has('d')) player.x += player.speed;
        if (keys.has('arrowup') || keys.has('w')) player.y -= player.speed;
        if (keys.has('arrowdown') || keys.has('s')) player.y += player.speed;
        player.x = Math.max(player.radius, Math.min(canvas.width - player.radius, player.x));
        player.y = Math.max(player.radius, Math.min(canvas.height - player.radius, player.y));

        const dx = player.x - star.x;
        const dy = player.y - star.y;
        if (Math.hypot(dx, dy) < player.radius + star.radius) {
          score += 1;
          scoreLabel.textContent = 'Stars: ' + score;
          placeStar();
        }

        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#f5df78';
        context.beginPath();
        context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = '#b8ef6a';
        context.beginPath();
        context.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
        context.fill();
        requestAnimationFrame(frame);
      }

      frame();
    </script>
  </body>
</html>
`;

const STARTER_CONTENT: Record<StudioStarterTemplateId, string> = {
  'html-game': HTML_GAME_STARTER,
  javascript:
    "// Start building here.\n\nfunction main() {\n  console.log('Hello from Flaxia Studio');\n}\n\nmain();\n",
  typescript:
    "// Start building here.\n\nfunction main(): void {\n  console.log('Hello from Flaxia Studio');\n}\n\nmain();\n",
  css: '/* Add styles here. */\n',
  json: '{\n  "name": "my-project"\n}\n',
};

export function createStudioStarterFile(templateId: StudioStarterTemplateId, requestedName: string): File {
  const template = STUDIO_STARTER_TEMPLATES.find((item) => item.id === templateId);
  if (!template) throw new Error('Choose a supported starter template');
  const name = requestedName.trim();
  if (!name) throw new Error('Enter a file name');
  const hasControlCharacter = Array.from(name).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (name.includes('/') || name.includes('\\') || hasControlCharacter || name === '.' || name === '..') {
    throw new Error('Use a file name without folders or control characters');
  }
  const fileName = name.toLowerCase().endsWith(template.extension) ? name : `${name}${template.extension}`;
  return new File([STARTER_CONTENT[templateId]], fileName, { type: template.mimeType });
}
