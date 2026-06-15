const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// ========== 配置（支持环境变量覆盖，方便迁移到其他机器） ==========
const DATA_DIR = process.env.TUWEN_DATA || 'D:\\Users\\HUAWEI\\Desktop\\AI TUWEN';
const CONFIG = {
  hotFile:  process.env.TUWEN_HOT    || path.join(DATA_DIR, '热点.txt'),
  priceFile: process.env.TUWEN_PRICE || path.join(DATA_DIR, 'price.xls'),
  adFile:    process.env.TUWEN_AD    || path.join(DATA_DIR, 'ad_template.txt.txt'),
  saveDir:   process.env.TUWEN_OUTPUT || path.join(DATA_DIR, 'output'),
  chromeDebugPort: parseInt(process.env.TUWEN_PORT)    || 9222,
  maxImageWait:    parseInt(process.env.TUWEN_MAXWAIT) || 300000,
};

// ========== 加载价格库 (xls) ==========
function loadPriceDB(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const db = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    db.push({
      brand: String(r[0] || '').trim(),
      tier:  String(r[1] || '').trim(),
      model: String(r[2] || '').trim(),
      price: '¥' + String(r[3] || '').trim(),
    });
  }
  return db;
}

// ========== 加载广告模板 ==========
function loadAdTemplates(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const templates = {};
  const blocks = content.split(/\[([^\]]+)\]/);
  let currentCategory = null;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue;
    if (i % 2 === 1) {
      currentCategory = block;
      templates[currentCategory] = {};
    } else if (currentCategory) {
      const tMatch = block.match(/template=(.+)/);
      const rMatch = block.match(/rule=(.+)/);
      if (tMatch) templates[currentCategory].template = tMatch[1].trim();
      if (rMatch) templates[currentCategory].rule = rMatch[1].trim();
    }
  }
  return templates;
}

// ========== 解析热点文件（新格式：## 选题 → ### 图N） ==========
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
        // 新的一组
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

// ========== 从文本提取机型 + 匹配价格 + 选广告 ==========
function extractAndMatch(promptText, topicTitle, priceDB, adTemplates) {
  // ---- 工具函数：文本规范化 ----
  function normalize(s) {
    return s
      .replace(/([一-鿿])([A-Za-z])/g, '$1 $2')
      .replace(/([A-Za-z])([一-鿿])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .replace(/(\d)([A-Za-z])/g, '$1 $2')
      .replace(/\s+/g, ' ');
  }

  const rawText = topicTitle + ' ' + promptText;
  const text = normalize(rawText).toLowerCase();
  const rawLower = rawText.toLowerCase();

  // ---- 品牌映射（含检测顺序 = 优先级） ----
  const brandKeywords = {
    '华为': ['华为', 'huawei'],
    '小米': ['小米', 'xiaomi'],
    '红米': ['红米', 'redmi'],
    'OPPO': ['oppo'],
    'vivo / iQOO': ['vivo', 'iqoo'],
    '荣耀': ['荣耀', 'honor'],
    '苹果': ['iphone', '苹果', 'apple'],
    '三星': ['三星', 'samsung'],
    '真我': ['真我', 'realme'],
    '一加': ['一加', 'oneplus'],
  };

  const mentionedBrands = new Set();
  for (const [brand, kws] of Object.entries(brandKeywords)) {
    if (kws.some(k => rawLower.includes(k))) {
      mentionedBrands.add(brand);
    }
  }

  // ---- 提取"主品牌"：话题标题中第一个命中的品牌 ----
  let primaryBrand = null;
  const topicLow = topicTitle.toLowerCase();
  for (const [brand, kws] of Object.entries(brandKeywords)) {
    if (kws.some(k => topicLow.includes(k))) {
      primaryBrand = brand;
      break;
    }
  }
  // 如果标题没有品牌，从全文取第一个
  if (!primaryBrand) {
    for (const [brand, kws] of Object.entries(brandKeywords)) {
      if (kws.some(k => rawLower.includes(k))) {
        primaryBrand = brand;
        break;
      }
    }
  }

  // ---- 提取话题中的型号数字 ----
  const textNums = [];
  const numRe = /\b(\d+)\b/g;
  let m;
  while ((m = numRe.exec(text)) !== null) {
    const n = parseInt(m[1]);
    if (n >= 3 && n <= 200) textNums.push(n);
  }
  // 主要型号数字：取最大的（通常是最新一代）
  const primaryNum = textNums.length > 0 ? Math.max(...textNums) : null;

  // ---- 判断话题的档位 ----
  const flagshipRe = /pro max|ultra|rs|非凡|ultimate|钛|fold|flip|折叠/i;
  const proRe = /pro\+|pro(?!\s*max)/i;
  const queryIsFlagship = flagshipRe.test(text);
  const queryIsPro = proRe.test(text);

  // ================================================================
  //  三级优先匹配规则
  // ================================================================

  let adModel = '';
  let adPrice = '';
  let cat = '安卓手机';
  let matchLevel = ''; // 用于日志

  // ---- 辅助函数：从 DB 查 iPhone 17 Pro Max ----
  function findInDB(modelName) {
    return priceDB.find(e => e.model.toLowerCase() === modelName.toLowerCase());
  }

  // ---- 辅助函数：同一品牌内选"旧一代旗舰" ----
  function pickSameBrandOlder(brand, topicNum, tierFlagship, tierPro) {
    const sameBrand = priceDB.filter(e => e.brand === brand);
    if (sameBrand.length === 0) return null;

    // 提取每个条目的数字和档位
    const candidates = sameBrand.map(e => {
      const eNum = parseInt((e.model.match(/\d+/) || ['0'])[0]);
      const eLow = e.model.toLowerCase();
      const eUltra = /pro max|ultra|rs|非凡|ultimate/i.test(eLow);
      const ePro = /pro\+|pro(?!\s*max)/i.test(eLow);
      return { ...e, eNum, eUltra, ePro };
    });

    // 如果知道话题型号数字，优先选数字≤话题数字的（旧一代或同代）
    if (topicNum !== null) {
      // 筛选：数字 ≤ 话题数字（旧一代旗舰）
      const older = candidates.filter(c => c.eNum <= topicNum);
      if (older.length > 0) {
        // 在同档位中选数字最大的（最接近的旧一代）
        const tierMatch = older.filter(c =>
          (tierFlagship && c.eUltra) || (tierPro && (c.eUltra || c.ePro))
        );
        if (tierMatch.length > 0) {
          tierMatch.sort((a, b) => b.eNum - a.eNum); // 数字大的优先
          return tierMatch[0];
        }
        // 无档位匹配，选数字最大的
        older.sort((a, b) => b.eNum - a.eNum);
        return older[0];
      }
    }

    // 无法确定数字时：选该品牌最高档、最新型号
    const ultra = candidates.filter(c => c.eUltra);
    if (ultra.length > 0) {
      ultra.sort((a, b) => b.eNum - a.eNum);
      return ultra[0];
    }
    const pro = candidates.filter(c => c.ePro);
    if (pro.length > 0) {
      pro.sort((a, b) => b.eNum - a.eNum);
      return pro[0];
    }
    candidates.sort((a, b) => b.eNum - a.eNum);
    return candidates[0];
  }

  // ---- 辅助函数：选 iPhone 旧一代旗舰 ----
  function pickIPhoneOlder(topicNum, tierFlagship, tierPro) {
    const iPhones = priceDB.filter(e => /苹果|iphone/i.test(e.brand));
    if (iPhones.length === 0) return null;

    const candidates = iPhones.map(e => {
      const eNum = parseInt((e.model.match(/\d+/) || ['0'])[0]);
      const eLow = e.model.toLowerCase();
      const eUltra = /pro max|ultra|rs|非凡|ultimate/i.test(eLow);
      const ePro = /pro\+|pro(?!\s*max)/i.test(eLow);
      return { ...e, eNum, eUltra, ePro };
    });

    if (topicNum !== null) {
      const older = candidates.filter(c => c.eNum <= topicNum);
      if (older.length > 0) {
        // 优先 Pro Max（苹果旗舰）
        const proMax = older.filter(c => c.eUltra);
        if (proMax.length > 0) {
          proMax.sort((a, b) => b.eNum - a.eNum);
          return proMax[0];
        }
        older.sort((a, b) => b.eNum - a.eNum);
        return older[0];
      }
    }

    // 默认选最新 Pro Max
    const proMax = candidates.filter(c => c.eUltra);
    if (proMax.length > 0) {
      proMax.sort((a, b) => b.eNum - a.eNum);
      return proMax[0];
    }
    candidates.sort((a, b) => b.eNum - a.eNum);
    return candidates[0];
  }

  // ================================================================
  //  PRIORITY 1：同品牌旧旗舰
  // ================================================================
  let match = null;
  if (primaryBrand) {
    match = pickSameBrandOlder(primaryBrand, primaryNum, queryIsFlagship, queryIsPro);
    if (match) {
      matchLevel = 'P1-同品牌旧旗舰';
    }
  }

  // ================================================================
  //  PRIORITY 2：iPhone（仅当完全识别不到品牌时）
  // ================================================================
  if (!match) {
    match = pickIPhoneOlder(primaryNum, queryIsFlagship, queryIsPro);
    if (match) {
      matchLevel = 'P2-iPhone旧旗舰';
    }
  }

  // ================================================================
  //  PRIORITY 3：硬默认 — iPhone 17 Pro Max / ¥6938
  // ================================================================
  if (!match) {
    // 先尝试从 DB 中找 iPhone 17 Pro Max
    const hardDefault = findInDB('iPhone 17 Pro Max');
    if (hardDefault) {
      match = hardDefault;
      matchLevel = 'P3-硬默认(DB)';
    } else {
      // DB 中没有就用硬编码值
      match = { model: 'iPhone 17 Pro Max', price: '¥6938', brand: '苹果' };
      matchLevel = 'P3-硬默认(硬编码)';
    }
  }

  // ---- 应用匹配结果 ----
  adModel = match.model;
  adPrice = match.price;
  if (/苹果|iphone|ipad/i.test(match.brand)) cat = '苹果手机';

  console.log(`     🎯 [${matchLevel}] → ${match.brand || '苹果'} ${adModel} ${adPrice}`);

  // ---- 收集辅助匹配（用于日志） ----
  const models = [adModel];
  const matchedPrices = [{ queryModel: adModel, model: adModel, price: adPrice, brand: match.brand }];

  // ---- 构建广告文案 ----
  const tpl = adTemplates[cat] || adTemplates['安卓手机'] || { template: '转转二手，{model}只要{price}元', rule: '' };

  return {
    models,
    matchedPrices,
    adText: tpl.template.replace(/\{model\}/g, adModel).replace(/\{price\}/g, adPrice),
    adRule: tpl.rule || '',
    adCategory: cat,
    adModel,
    adPrice,
  };
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
  // 先关闭可能弹出的模态框（如"来冒个泡"等 ChatGPT 弹窗）
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

  // 用 force click 避免被模态框残留遮挡
  await input.click({ force: true });
  await page.waitForTimeout(500);
  await input.fill(prompt);
  await page.waitForTimeout(500);

  const sendBtn = page.locator('button[data-testid="send-button"]').first();
  try {
    await sendBtn.click({ timeout: 15000 });
  } catch {
    // 兜底：Enter 发送
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
  return true; // timeout but continue
}

// ========== 下载最新图片 ==========
const seenUrls = new Set();

async function downloadLatestImage(page, saveDir, fileName) {
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  // 🔑 先滚动到底部，触发 ChatGPT 图片懒加载 & 渲染
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);

  // 🔑 在最新 assistant 消息中找图片（比全局搜更精准）
  //   ChatGPT 有时用 picture 元素、canvas、或延迟很久才插入 img 标签
  let candidates = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(3000);

    // 多样滚动策略：GPT 图片往往是懒加载，需要真实滚动触发
    const scrollMode = attempt % 3;
    if (scrollMode === 0) {
      // 快速滚到底部再回来
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        setTimeout(() => window.scrollTo(0, document.body.scrollHeight - 600), 200);
      });
    } else if (scrollMode === 1) {
      // 逐步滚动（模拟用户浏览）
      await page.evaluate(() => {
        const h = document.body.scrollHeight;
        window.scrollTo(0, h);
        setTimeout(() => window.scrollTo(0, h - 400), 150);
      });
    } else {
      // 滚到底部停顿
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    }
    await page.waitForTimeout(1000);

    candidates = await page.evaluate(({ seenArr, attemptNum }) => {
      const seen = new Set(seenArr);
      const result = [];
      const MIN_W = 300, MIN_H = 300;

      // 优先在最新的 conversation-turn 中查找
      const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : document;

      // 1) 标准 <img> 标签
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

      // 2) <picture> 元素内的 <img>
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

      // 3) data:image/png;base64 大图 (ChatGPT 偶尔用)
      const searchDataUris = (container) => {
        const imgs = container.querySelectorAll('img[src^="data:image/png"], img[src^="data:image/jpeg"], img[src^="data:image/webp"]');
        for (const img of imgs) {
          const src = img.src || '';
          if (src.length < 50000) continue; // 跳过小图标（真正的图片 base64 很大）
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

      // 如果最新 turn 里没有，扩大到全局
      if (result.length === 0) {
        searchImgs(document);
        searchPictures(document);
        searchDataUris(document);
      }

      // 调试：如果是每5次扫描且无结果，dump 所有 img 信息
      if (result.length === 0 && attemptNum % 5 === 4) {
        const allImgs = document.querySelectorAll('img');
        const dump = [];
        for (const img of allImgs) {
          dump.push({
            src: (img.src || '').substring(0, 120),
            w: img.naturalWidth || img.width,
            h: img.naturalHeight || img.height,
            ratio: ((img.naturalWidth || img.width) / (img.naturalHeight || img.height)).toFixed(2),
          });
        }
        // 通过 window.__debugImgs 传回
        window.__debugImgs = JSON.stringify(dump);
      }

      return result;
    }, { seenArr: [...seenUrls], attemptNum: attempt });

    // 无结果时打印调试信息
    if (candidates.length === 0 && attempt % 5 === 4) {
      const debugRaw = await page.evaluate(() => window.__debugImgs || 'null');
      try {
        const debugImgs = JSON.parse(debugRaw);
        if (debugImgs && debugImgs.length > 0) {
          console.log(`     🔎 第${attempt + 1}次扫描，页面有 ${debugImgs.length} 个 img 但均不符合条件：`);
          for (const d of debugImgs.slice(0, 10)) {
            console.log(`        src=${d.src} | ${d.w}x${d.h} | ratio=${d.ratio}`);
          }
        } else {
          console.log(`     🔎 第${attempt + 1}次扫描，页面无任何 img 标签`);
        }
      } catch {}
    }

    if (candidates.length > 0) {
      console.log(`     🔍 第${attempt + 1}次扫描命中 ${candidates.length} 张候选图`);
      break;
    }
    console.log(`     ⏳ 第${attempt + 1}次扫描未找到图片，重试...`);
  }

  if (candidates.length === 0) {
    // 最后兜底：完全不设条件，等额外 15 秒再扫一次
    console.log('     🔍 所有条件放宽，额外等待 15 秒最后尝试...');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(8000);
    // 继续滚几轮
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
        // img
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
        // picture
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

  // 按面积排序，取最大的图（ChatGPT 生成的图通常最大）
  candidates.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  const best = candidates[0];
  console.log(`     🎯 选中: ${best.w}x${best.h}`);

  let downloaded = false;
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
        continue; // 太小，试下一个候选
      }
      downloaded = true;
      return { file, kb };
    }
  }

  if (!downloaded) {
    // 所有候选都失败，走截图兜底
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
  }
  return null;
}

// ========== MAIN ==========
(async () => {
  console.log('========================================');
  console.log('  ChatGPT 自动化：热点 → 图文 → 广告');
  console.log('========================================\n');

  // 启动前检测
  console.log('🔍 启动前检测...');
  const checks = [
    { k: '热点', p: CONFIG.hotFile },
    { k: '价格', p: CONFIG.priceFile },
    { k: '广告', p: CONFIG.adFile },
    { k: '输出', p: CONFIG.saveDir },
  ];
  for (const c of checks) {
    const ok = fs.existsSync(c.p);
    console.log('  ' + (ok ? '✅' : '❌') + ' ' + c.k + ': ' + c.p);
    if (!ok) { console.log('\n⚠️ 文件缺失，终止'); process.exit(1); }
  }

  // 加载数据
  const pairs = parseHotFile(CONFIG.hotFile);
  const priceDB = loadPriceDB(CONFIG.priceFile);
  const adTemplates = loadAdTemplates(CONFIG.adFile);
  console.log(`\n📄 ${pairs.length} 组选题`);
  console.log(`💰 ${priceDB.length} 条价格`);
  console.log(`📢 ${Object.keys(adTemplates).length} 类广告模板\n`);

  if (pairs.length === 0) { console.log('❌ 未解析到选题，请检查文件格式'); process.exit(1); }

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
      const isEven = imgNum % 2 === 0; // 偶数图 = 解析图 = 需要加广告

      let prompt = img.prompt;

      // 🔑 偶数图：注入广告区
      if (isEven) {
        console.log(`\n  📊 图${imgNum} (解析图) → 提取机型 + 匹配价格 + 注入广告...`);
        const info = extractAndMatch(img.prompt, pair.topicTitle, priceDB, adTemplates);
        console.log(`     📱 机型: ${info.models.join(', ') || '未识别'}`);
        console.log(`     💰 价格: ${info.matchedPrices.map(p => p.model + '=' + p.price).join(', ') || '无匹配'}`);
        console.log(`     📢 广告: [${info.adCategory}] ${info.adModel} ${info.adPrice}`);

        // 🔑 替换热点文件中的占位符 {TOP1_MODEL} {TOP1_PRICE} {AD_TEXT}
        prompt = prompt
          .replace(/\{TOP1_MODEL\}/g, info.adModel)
          .replace(/\{TOP1_PRICE\}/g, info.adPrice)
          .replace(/\{AD_TEXT\}/g, info.adText);
        console.log(`     🔄 已替换占位符: TOP1_MODEL→${info.adModel}, TOP1_PRICE→${info.adPrice}`);

        // 在 prompt 末尾追加广告区
        const adBlock = `

【底部 20% 广告区】
使用以下广告文案（字体稍小，不抢主内容，占比约10%）：
"${info.adText}"
规则：${info.adRule}`;
        prompt = prompt + adBlock;
      }

      // 加静默指令，避免 ChatGPT 闲聊
      prompt = '不要和我闲聊。直接生成3：4图片。\n' + prompt;

      try {
        console.log(`\n  🎨 图${imgNum}: 发送Prompt (${prompt.length} 字符)...`);
        await sendMessage(page, prompt);
        console.log(`  ⏳ 等待生成...`);
        await waitForDone(page, CONFIG.maxImageWait);
        // 生成完成后额外等待图片渲染（滚动触发懒加载）
        console.log(`  🖼 等待图片渲染...`);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(15000); // 增加到 15s 给图片充足渲染时间

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
          break; // 跳出图片循环
        }
      }
    }

    console.log(`\n  🎉 [${pairLabel}] 完成`);
  }

  const pngs = fs.readdirSync(CONFIG.saveDir).filter(f => f.endsWith('.png')).length;
  console.log(`\n\n🎉 全部完成！${pngs} 张PNG → ${CONFIG.saveDir}`);
})();
