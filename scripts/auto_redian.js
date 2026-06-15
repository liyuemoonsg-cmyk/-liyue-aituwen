const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const DATA_DIR = process.env.REDIAN_DATA || 'D:\\REDIAN';
const CONFIG = {
  hotFile:   process.env.REDIAN_HOT    || path.join(DATA_DIR, '热点.txt'),
  saveDir:   process.env.REDIAN_OUTPUT || path.join(DATA_DIR, 'output'),
  chromeDebugPort: parseInt(process.env.REDIAN_PORT)    || 9222,
  maxImageWait:    parseInt(process.env.REDIAN_MAXWAIT) || 300000,
};

// ========== 解析热点文件（格式：## 选题 → ### 图N） ==========
function parseHotFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const pairs = [];           // [{ topicTitle, images: [{num, label, prompt}] }]
  let currentTopic = '';
  let currentPair = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 选题标题（兼容 #选题N｜ / #① / # ① 等格式）
    const topicMatch = line.trim().match(/^#{1,2}\s+(?:选题\d+[｜|：:]\s*|[①-⑳]\s+)(.+)/);
    if (topicMatch) {
      currentTopic = topicMatch[1].trim();
      continue;
    }

    // 图N 标记（兼容 ## 和 ###）
    const imgMatch = line.trim().match(/^#{2,3}\s+图(\d+)[｜|：:]\s*(.+)/);
    if (imgMatch) {
      const num = parseInt(imgMatch[1]);
      const label = imgMatch[2].trim();
      if (num === 1) {
        currentPair = { topicTitle: currentTopic, images: [] };
        pairs.push(currentPair);
      }
      if (currentPair) {
        currentPair.images.push({ num, label, lines: [] });
      }
      continue;
    }

    // 收集当前图的内容行
    if (currentPair && currentPair.images.length > 0) {
      currentPair.images[currentPair.images.length - 1].lines.push(line);
    }
  }

  // 合并每个图的 lines → prompt
  for (const pair of pairs) {
    for (const img of pair.images) {
      img.prompt = img.lines.join('\n').trim();
      delete img.lines;
    }
  }

  return pairs;
}

// ========== 启动/连接 Chrome ==========
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

// ========== 打开 ChatGPT ==========
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

// ========== 发送消息 ==========
async function sendMessage(page, prompt) {
  // 关闭可能弹出的模态框
  for (let i = 0; i < 5; i++) {
    const modal = page.locator('[data-testid="modal-beacon"] > div[data-state="open"]').first();
    if (await modal.isVisible({ timeout: 500 }).catch(() => false)) {
      console.log('     ⚠️ 检测到弹窗，按 Escape 关闭...');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1500);
    } else {
      break;
    }
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

// ========== 等待生成完成 ==========
async function waitForDone(page, maxWait) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await page.waitForTimeout(3000);
    const stopBtn = page.locator('button[aria-label*="Stop"], button[data-testid="stop-button"]').first();
    const running = await stopBtn.isVisible().catch(() => false);
    if (!running) {
      await page.waitForTimeout(3000);
      if (!(await stopBtn.isVisible().catch(() => false))) return true;
    }
  }
  return true;
}

// ========== 下载最新图片 ==========
const seenUrls = new Set();

async function downloadLatestImage(page, saveDir, fileName) {
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  // 滚动触发懒加载
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);

  let candidates = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(3000);

    // 多样滚动策略
    const scrollMode = attempt % 3;
    if (scrollMode === 0) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        setTimeout(() => window.scrollTo(0, document.body.scrollHeight - 600), 200);
      });
    } else if (scrollMode === 1) {
      await page.evaluate(() => {
        const h = document.body.scrollHeight;
        window.scrollTo(0, h);
        setTimeout(() => window.scrollTo(0, h - 400), 150);
      });
    } else {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    }
    await page.waitForTimeout(1000);

    candidates = await page.evaluate(({ seenArr, attemptNum }) => {
      const seen = new Set(seenArr);
      const result = [];
      const MIN_W = 300, MIN_H = 300;

      const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : document;

      const searchImgs = (container) => {
        const imgs = container.querySelectorAll('img');
        for (const img of imgs) {
          const src = img.src || '';
          if (!src.startsWith('https://') && !src.startsWith('blob:')) continue;
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (w < MIN_W || h < MIN_H) continue;
          const ratio = w / h;
          if (ratio < 0.35 || ratio > 1.4) continue;
          if (seen.has(src)) continue;
          if (src.includes('favicon') || src.includes('/icon') || src.includes('avatar')) continue;
          if (src.includes('data:image/svg')) continue;
          result.push({ url: src, w, h });
        }
      };

      const searchPictures = (container) => {
        const pictures = container.querySelectorAll('picture');
        for (const pic of pictures) {
          const img = pic.querySelector('img');
          if (!img) continue;
          const src = img.src || img.currentSrc || '';
          if (!src.startsWith('https://') && !src.startsWith('blob:')) continue;
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (w < MIN_W || h < MIN_H) continue;
          const ratio = w / h;
          if (ratio < 0.35 || ratio > 1.4) continue;
          if (seen.has(src)) continue;
          result.push({ url: src, w, h });
        }
      };

      const searchDataUris = (container) => {
        const imgs = container.querySelectorAll('img[src^="data:image/png"], img[src^="data:image/jpeg"], img[src^="data:image/webp"]');
        for (const img of imgs) {
          const src = img.src || '';
          if (src.length < 50000) continue;
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (w < MIN_W || h < MIN_H) continue;
          if (seen.has(src)) continue;
          result.push({ url: src, w, h });
        }
      };

      searchImgs(lastTurn);
      searchPictures(lastTurn);
      searchDataUris(lastTurn);

      if (result.length === 0) {
        searchImgs(document);
        searchPictures(document);
        searchDataUris(document);
      }

      return result;
    }, { seenArr: [...seenUrls], attemptNum: attempt });

    if (candidates.length > 0) {
      console.log(`     🔍 第${attempt + 1}次扫描命中 ${candidates.length} 张候选图`);
      break;
    }
    console.log(`     ⏳ 第${attempt + 1}次扫描未找到图片，重试...`);
  }

  if (candidates.length === 0) {
    // 兜底：放宽条件再扫
    console.log('     🔍 放宽条件最后尝试...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(8000);
    for (let s = 0; s < 4; s++) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight - 300);
        setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 200);
      });
      await page.waitForTimeout(2000);
    }
    candidates = await page.evaluate(({ seenArr }) => {
      const seen = new Set(seenArr);
      function collect(container) {
        const result = [];
        for (const img of container.querySelectorAll('img')) {
          const src = img.src || img.currentSrc || '';
          if (!src || src.length < 20) continue;
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          if (w < 150 || h < 150) continue;
          if (seen.has(src)) continue;
          if (src.includes('favicon') || src.includes('/icon') || src.includes('avatar') || src.includes('data:image/svg')) continue;
          result.push({ url: src, w, h });
        }
        for (const pic of container.querySelectorAll('picture')) {
          const img = pic.querySelector('img');
          if (!img) continue;
          const src = img.src || img.currentSrc || '';
          if (!src || src.length < 20) continue;
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          if (w < 150 || h < 150) continue;
          if (seen.has(src)) continue;
          result.push({ url: src, w, h });
        }
        return result;
      }
      const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : document;
      let r = collect(lastTurn);
      if (r.length === 0) r = collect(document);
      return r;
    }, { seenArr: [...seenUrls] });
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
        const kb = Math.round(fs.statSync(file).size / 1024);
        if (kb < 50) {
          console.log(`     ⚠️ 截图过小 (${kb}KB)，可能图片未渲染，但已保存`);
        }
        return { file, kb };
      }
    } catch (e) {
      console.log('     ⚠️ 截图兜底也失败: ' + e.message);
    }
    return null;
  }

  // 按面积排序，取最大
  candidates.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  const best = candidates[0];
  console.log(`     🎯 选中: ${best.w}x${best.h}`);

  for (const { url } of [best]) {
    seenUrls.add(url);
    let base64 = null;

    // 方式1: fetch inside page
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

    // 方式2: canvas 截图
    if (!base64 || !base64.includes('base64,')) {
      console.log('     🔄 fetch失败，改用canvas截图...');
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
              return canvas.toDataURL('image/png', 1.0);
            }
          }
          return null;
        } catch { return null; }
      }, url);
    }

    if (base64?.includes('base64,')) {
      const file = path.join(saveDir, fileName);
      fs.writeFileSync(file, Buffer.from(base64.split('base64,')[1], 'base64'));
      const kb = Math.round(fs.statSync(file).size / 1024);
      if (kb < 50) {
        console.log(`     ⚠️ 下载图片过小 (${kb}KB)，疑似占位图，继续尝试...`);
        continue;
      }
      return { file, kb };
    }
  }

  // 兜底截图
  console.log('     📸 下载失败，使用页面截图兜底...');
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

// ========== MAIN ==========
(async () => {
  console.log('========================================');
  console.log('  热点话题 → ChatGPT 图文（简化版）');
  console.log('========================================\n');

  // 启动前检测
  console.log('🔍 启动前检测...');
  if (!fs.existsSync(CONFIG.hotFile)) {
    console.log(`  ❌ 热点文件不存在: ${CONFIG.hotFile}`);
    console.log('  请将选题文件放到 D:\\REDIAN\\热点.txt');
    process.exit(1);
  }
  console.log(`  ✅ 热点: ${CONFIG.hotFile}`);
  console.log(`  ✅ 输出: ${CONFIG.saveDir}\n`);

  // 解析选题
  const pairs = parseHotFile(CONFIG.hotFile);
  console.log(`📄 解析到 ${pairs.length} 组选题`);
  if (pairs.length === 0) {
    console.log('❌ 未解析到选题，请检查文件格式');
    process.exit(1);
  }

  // 打印概览
  for (let pi = 0; pi < pairs.length; pi++) {
    const p = pairs[pi];
    console.log(`  ${pi + 1}. ${p.topicTitle} (${p.images.length} 张图)`);
  }
  console.log('');

  // 连接浏览器
  const browser = await connectChrome(CONFIG.chromeDebugPort);
  let page = await openChatGPT(browser);

  for (let pi = 0; pi < pairs.length; pi++) {
    const pair = pairs[pi];
    const pairLabel = String(pi + 1).padStart(2, '0');
    console.log(`\n${'='.repeat(55)}`);
    console.log(`  📱 [${pairLabel}] ${pair.topicTitle}`);
    console.log(`  🖼  共 ${pair.images.length} 张图`);
    console.log(`${'='.repeat(55)}`);

    for (let ii = 0; ii < pair.images.length; ii++) {
      const img = pair.images[ii];
      const imgNum = ii + 1;

      // 简洁 prompt，只加静默指令
      let prompt = '不要和我闲聊。直接生成3：4图片。\n' + img.prompt;

      try {
        console.log(`\n  🎨 图${imgNum}: 发送Prompt (${prompt.length} 字符)...`);
        await sendMessage(page, prompt);
        console.log(`  ⏳ 等待生成...`);
        await waitForDone(page, CONFIG.maxImageWait);
        console.log(`  🖼 等待图片渲染...`);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(15000);

        const fileName = `${pairLabel}_${imgNum}.png`;
        const result = await downloadLatestImage(page, CONFIG.saveDir, fileName);
        if (result) {
          console.log(`  ✅ ${fileName} (${result.kb} KB)`);
        } else {
          console.log(`  ⚠️ ${fileName} 未检测到`);
        }

        await page.waitForTimeout(3000);
      } catch (err) {
        console.log(`  ❌ 图${imgNum}出错: ${err.message}`);
        // 尝试恢复页面
        try {
          const pages = browser.contexts()[0].pages();
          const chatPage = pages.find(p => p.url().includes('chatgpt.com'));
          if (chatPage && chatPage !== page) {
            page = chatPage;
            console.log('  🔄 已切换到现有 ChatGPT 页面');
          } else {
            page = await browser.contexts()[0].newPage();
            await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);
            console.log('  🔄 已重新打开 ChatGPT 页面');
          }
        } catch (e2) {
          console.log(`  💥 页面恢复失败: ${e2.message}，跳过后续...`);
          break;
        }
      }
    }

    console.log(`\n  🎉 [${pairLabel}] 完成`);
  }

  const pngs = fs.readdirSync(CONFIG.saveDir).filter(f => f.endsWith('.png')).length;
  console.log(`\n\n🎉 全部完成！${pngs} 张PNG → ${CONFIG.saveDir}`);
})();
