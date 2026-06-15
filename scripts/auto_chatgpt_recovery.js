// 修复脚本：重跑失败的封面图（01_1, 02_1, 06_1）
// 核心修复：封面图渲染慢 → 翻倍重试轮数 + 加长等待

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  hotFile: 'D:\\Users\\HUAWEI\\Desktop\\AI TUWEN\\热点.txt',
  saveDir: 'D:\\Users\\HUAWEI\\Desktop\\AI TUWEN\\output',
  chromeDebugPort: 9222,
  maxImageWait: 300000,
};

// 只提取失败选题 (01, 02, 06) 的图1
const FAILED_INDICES = [0, 1, 5]; // 0-based

function parseHotFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const pairs = [];
  let currentTopic = '';
  let currentPair = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const topicMatch = line.trim().match(/^#{1,2}\s+(?:选题\d+[｜|：:]\s*|[①-⑳]\s+)(.+)/);
    if (topicMatch) {
      currentTopic = topicMatch[1].trim();
      continue;
    }
    const imgMatch = line.trim().match(/^#{2,3}\s+图(\d+)[｜|：:]\s*(.+)/);
    if (imgMatch) {
      const num = parseInt(imgMatch[1]);
      if (num === 1) {
        currentPair = { topicTitle: currentTopic, images: [] };
        pairs.push(currentPair);
      }
      if (currentPair) {
        currentPair.images.push({ num, label: imgMatch[2].trim(), lines: [] });
      }
      continue;
    }
    if (currentPair && currentPair.images.length > 0) {
      currentPair.images[currentPair.images.length - 1].lines.push(line);
    }
  }
  for (const pair of pairs) {
    for (const img of pair.images) {
      img.prompt = img.lines.join('\n').trim();
      delete img.lines;
    }
  }
  return pairs;
}

async function connectChrome(port) {
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    console.log('✅ 已连接 Chrome');
    return browser;
  } catch {
    console.log('启动 Chrome（调试模式）...');
    const tempDir = path.join(process.env.LOCALAPPDATA, 'ChromeDebug');
    const { spawn } = require('child_process');
    spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      `--remote-debugging-port=${port}`, `--user-data-dir=${tempDir}`, '--start-maximized',
    ], { detached: true, stdio: 'ignore' });
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch {}
    }
    throw new Error('Chrome 启动超时');
  }
}

async function openChatGPT(browser) {
  const pages = browser.contexts()[0].pages();
  let page = pages.find(p => p.url().includes('chatgpt.com'));
  if (!page) {
    page = await browser.contexts()[0].newPage();
    await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('✅ 已打开 ChatGPT');
  } else {
    console.log('✅ 已有 ChatGPT 标签页');
  }
  await page.waitForTimeout(2000);
  return page;
}

async function sendMessage(page, prompt) {
  for (let i = 0; i < 5; i++) {
    const modal = page.locator('[data-testid="modal-beacon"] > div[data-state="open"]').first();
    if (await modal.isVisible({ timeout: 500 }).catch(() => false)) {
      console.log('     ⚠️ 检测到弹窗，按 Escape 关闭...');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1500);
    } else { break; }
  }
  const input = page.locator('#prompt-textarea').first();
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.click({ force: true });
  await page.waitForTimeout(500);
  await input.fill(prompt);
  await page.waitForTimeout(500);
  const sendBtn = page.locator('button[data-testid="send-button"]').first();
  try {
    await sendBtn.click({ timeout: 15000 });
  } catch {
    await page.keyboard.press('Enter');
  }
}

async function waitForDone(page, maxWait) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await page.waitForTimeout(3000);
    const stopBtn = page.locator('button[aria-label*="Stop"], button[data-testid="stop-button"]').first();
    const running = await stopBtn.isVisible().catch(() => false);
    if (!running) {
      await page.waitForTimeout(5000);
      if (!(await stopBtn.isVisible().catch(() => false))) return true;
    }
  }
  return true;
}

// =================== 核心修复：增强版图片下载（只看最新回复） ===================
async function downloadLatestImageEnhanced(page, saveDir, fileName) {
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  // 🔧 修复1：初始等待从 10s → 30s，给封面图充分的渲染时间
  console.log('     🔧 [增强模式] 等待 30s 让封面图充分渲染...');
  await page.waitForTimeout(30000);

  // 🔧 修复2：滚动到页面底部，确保最新图片进入视口（触发懒加载）
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(5000);

  // 🔧 修复3：翻倍重试 — 15 轮 × 5s = 75s，只扫描最新一条回复
  let candidates = [];
  for (let attempt = 0; attempt < 15; attempt++) {
    await page.waitForTimeout(5000);
    candidates = await page.evaluate(() => {
      // 🔑 关键修复：只扫描最新一条 ChatGPT 回复中的图片
      const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : document;
      const imgs = lastTurn.querySelectorAll('img');
      const result = [];
      for (const img of imgs) {
        const src = img.src || '';
        if (!src.startsWith('https://') && !src.startsWith('blob:')) continue;
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w < 600 || h < 800) continue;
        const ratio = w / h;
        if (ratio < 0.65 || ratio > 0.85) continue;
        if (src.includes('favicon') || src.includes('/icon') || src.includes('avatar')) continue;
        result.push({ url: src, w, h });
      }
      return result;
    });

    if (candidates.length > 0) break;
    console.log(`     ⏳ 第${attempt + 1}次扫描未找到图片，重试...`);
  }

  if (candidates.length === 0) {
    console.log('     🔍 严格条件未命中，放宽条件重扫...');
    await page.waitForTimeout(10000);
    candidates = await page.evaluate(() => {
      // 放宽后也只扫最新回复
      const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : document;
      const imgs = lastTurn.querySelectorAll('img');
      const result = [];
      for (const img of imgs) {
        const src = img.src || '';
        if (!src.startsWith('https://') && !src.startsWith('blob:')) continue;
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w < 400 || h < 400) continue;
        if (src.includes('favicon') || src.includes('/icon') || src.includes('avatar')) continue;
        result.push({ url: src, w, h });
      }
      return result;
    });

    if (candidates.length > 0) {
      console.log(`     🔍 放宽后找到 ${candidates.length} 张候选图片`);
    }
  }

  if (candidates.length === 0) {
    console.log('     📸 图片检测失败，使用页面截图兜底...');
    try {
      const turns = page.locator('[data-testid^="conversation-turn-"]');
      const count = await turns.count();
      if (count > 0) {
        const lastTurn = turns.nth(count - 1);
        const buffer = await lastTurn.screenshot({ type: 'png' });
        const file = path.join(saveDir, fileName);
        fs.writeFileSync(file, buffer);
        return { file, kb: Math.round(fs.statSync(file).size / 1024) };
      }
    } catch (e) {
      console.log('     ⚠️ 截图兜底也失败: ' + e.message);
    }
    return null;
  }

  // 取宽度最大的图
  candidates.sort((a, b) => b.w - a.w);
  const best = candidates[0];
  console.log(`     🖼  最佳候选: ${best.w}×${best.h}`);

  for (const { url } of [best]) {
    let base64 = null;

    base64 = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) return null;
        const b = await r.blob();
        return new Promise(res => {
          const reader = new FileReader();
          reader.onloadend = () => res(reader.result);
          reader.readAsDataURL(b);
        });
      } catch { return null; }
    }, url);

    if (!base64 || !base64.includes('base64,')) {
      base64 = await page.evaluate(async (u) => {
        try {
          const imgs = document.querySelectorAll('img');
          for (const img of imgs) {
            if (img.src === u && img.naturalWidth > 200) {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0);
              return canvas.toDataURL('image/png');
            }
          }
          return null;
        } catch { return null; }
      }, url);
    }

    if (base64?.includes('base64,')) {
      const file = path.join(saveDir, fileName);
      fs.writeFileSync(file, Buffer.from(base64.split('base64,')[1], 'base64'));
      return { file, kb: Math.round(fs.statSync(file).size / 1024) };
    }
  }
  return null;
}

(async () => {
  console.log('========================================');
  console.log('  🔧 封面图修复重跑 (01_1, 02_1, 06_1)');
  console.log('  增强模式: 30s初始等待 + 15轮×5s扫描');
  console.log('========================================\n');

  if (!fs.existsSync(CONFIG.hotFile)) {
    console.log('❌ 热点文件不存在'); process.exit(1);
  }

  const allPairs = parseHotFile(CONFIG.hotFile);
  console.log(`📄 共 ${allPairs.length} 组选题，修复其中 3 组\n`);

  const failedPairs = FAILED_INDICES.map(idx => ({ idx, pair: allPairs[idx] })).filter(p => p.pair);

  const browser = await connectChrome(CONFIG.chromeDebugPort);
  // 🔑 强制开新对话，避免在旧对话里扫描到之前的图片
  const page = await browser.contexts()[0].newPage();
  await page.goto('https://chatgpt.com/?newChat=true', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('✅ 已打开新对话');
  await page.waitForTimeout(3000);

  for (const { idx, pair } of failedPairs) {
    const pairLabel = String(idx + 1).padStart(2, '0');
    const coverImg = pair.images[0]; // 图1
    if (!coverImg) continue;

    console.log(`\n${'='.repeat(55)}`);
    console.log(`  🔧 [${pairLabel}] ${pair.topicTitle} → 仅图1(封面)`);
    console.log(`${'='.repeat(55)}`);

    const prompt = '不要和我闲聊。直接生成3：4图片。\n' + coverImg.prompt;

    console.log(`\n  🎨 发送Prompt (${prompt.length} 字符)...`);
    await sendMessage(page, prompt);
    console.log(`  ⏳ 等待生成...`);
    await waitForDone(page, CONFIG.maxImageWait);

    const fileName = `${pairLabel}_1.png`;
    const result = await downloadLatestImageEnhanced(page, CONFIG.saveDir, fileName);
    if (result) {
      console.log(`  ✅ ${fileName} (${result.kb} KB)`);
      if (result.kb < 100) {
        console.log(`  ⚠️ 文件仍然偏小，可能仍是截图兜底`);
      }
    } else {
      console.log(`  ❌ ${fileName} 下载失败`);
    }

    await page.waitForTimeout(3000);
    console.log(`\n  🎉 [${pairLabel}] 修复完成`);
  }

  console.log(`\n\n✅ 修复流程结束，检查: ${CONFIG.saveDir}`);
})();
