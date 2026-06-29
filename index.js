import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import fs from "fs";
import axios from "axios";
import * as cheerio from "cheerio";

dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const ADMIN_ID = String(process.env.ADMIN_ID || "");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const SITES_FILE = "sites.json";
const pending = {};

const LIMIT_SITES = 5;
const LIMIT_RESULT_PAGES = 8;

function loadSites() {
  if (!fs.existsSync(SITES_FILE)) {
    fs.writeFileSync(
      SITES_FILE,
      JSON.stringify({ movie: [], song: [], apk: [] }, null, 2)
    );
  }

  try {
    const data = JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
    return {
      movie: data.movie || [],
      song: data.song || [],
      apk: data.apk || []
    };
  } catch {
    return { movie: [], song: [], apk: [] };
  }
}

function saveSites(data) {
  fs.writeFileSync(SITES_FILE, JSON.stringify(data, null, 2));
}

function isAdmin(id) {
  return String(id) === ADMIN_ID;
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function buildSearchUrl(site, query) {
  const q = encodeURIComponent(query.trim());

  if (site.includes("{query}")) return site.replace("{query}", q);
  if (site.endsWith("=")) return site + q;
  if (site.endsWith("/")) return site + q;

  return `${site}${site.includes("?") ? "&" : "?"}q=${q}`;
}

function makeAbsolute(href, baseUrl) {
  try {
    if (!href) return null;
    return href.startsWith("http") ? href : new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function isAudioLink(url) {
  const clean = url.toLowerCase().split("?")[0];
  return (
    clean.endsWith(".mp3") ||
    clean.endsWith(".m4a") ||
    clean.endsWith(".wav") ||
    clean.endsWith(".ogg")
  );
}

function isApkLink(url) {
  return url.toLowerCase().split("?")[0].endsWith(".apk");
}

function isTargetFile(url, category) {
  if (category === "song") return isAudioLink(url);
  if (category === "apk") return isApkLink(url);
  return false;
}

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  return res.data;
}

async function askGemini(text) {
  if (!GEMINI_API_KEY) {
    return { category: "unclear", query: text };
  }

  const prompt = `
You are a Telegram search bot. Always reply only in English.

User message: "${text}"

Detect category: movie, song, apk, or unclear.

Rules:
- If user clearly asks movie, return movie.
- If user clearly asks song/music/audio, return song.
- If user clearly asks apk/app, return apk.
- If only a title/name is given, return unclear.

Return JSON only:
{"category":"movie|song|apk|unclear","query":"clean search text"}
`;

  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { timeout: 12000 }
    );

    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text
      ?.replace(/```json/g, "")
      ?.replace(/```/g, "")
      ?.trim();

    return JSON.parse(raw);
  } catch {
    return { category: "unclear", query: text };
  }
}

async function collectLinksFromPage(url, query, category) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const links = [];
    const seen = new Set();
    const q = query.toLowerCase();

    $("a").each((_, el) => {
      const title =
        cleanText($(el).text()) ||
        cleanText($(el).attr("title")) ||
        cleanText($(el).attr("aria-label"));

      const href = $(el).attr("href");
      const link = makeAbsolute(href, url);

      if (!link || seen.has(link)) return;
      seen.add(link);

      const t = title.toLowerCase();

      const matchText =
        t.includes(q) ||
        q.split(" ").some((w) => w.length > 2 && t.includes(w));

      if (matchText || isTargetFile(link, category)) {
        links.push({
          title: title || query,
          link
        });
      }
    });

    $("audio source, video source, source").each((_, el) => {
      const src = $(el).attr("src");
      const link = makeAbsolute(src, url);

      if (link && !seen.has(link)) {
        seen.add(link);
        links.push({ title: query, link });
      }
    });

    return links.slice(0, 25);
  } catch {
    return [];
  }
}

async function deepFindFile(resultLinks, category) {
  for (const item of resultLinks.slice(0, LIMIT_RESULT_PAGES)) {
    if (isTargetFile(item.link, category)) return item;

    const innerLinks = await collectLinksFromPage(
      item.link,
      item.title,
      category
    );

    const file = innerLinks.find((x) => isTargetFile(x.link, category));

    if (file) {
      return {
        title: item.title,
        link: file.link
      };
    }
  }

  return null;
}

async function handleSearch(chatId, category, query) {
  const sites = loadSites();
  const list = sites[category] || [];

  if (list.length === 0) {
    return bot.sendMessage(chatId, `No ${category} websites added yet.`);
  }

  await bot.sendMessage(chatId, `Searching ${category} results for: ${query}`);

  let allResults = [];

  for (const site of list.slice(0, LIMIT_SITES)) {
    const searchUrl = buildSearchUrl(site, query);
    const results = await collectLinksFromPage(searchUrl, query, category);
    allResults.push(...results);
  }

  const unique = [];
  const seen = new Set();

  for (const r of allResults) {
    if (!seen.has(r.link)) {
      seen.add(r.link);
      unique.push(r);
    }
  }

  if (unique.length === 0) {
    const firstSite = list[0];
    const searchUrl = buildSearchUrl(firstSite, query);

    return bot.sendMessage(
      chatId,
      `No results found by parser.\n\nOpen search page:\n${searchUrl}`,
      { disable_web_page_preview: true }
    );
  }

  if (category === "song" || category === "apk") {
    await bot.sendMessage(chatId, "Checking result pages deeply...");

    const file = await deepFindFile(unique, category);

    if (file && category === "song") {
      await bot.sendMessage(chatId, `Audio found: ${file.title}\nSending now...`);
      return bot.sendAudio(chatId, file.link, { title: file.title });
    }

    if (file && category === "apk") {
      await bot.sendMessage(chatId, `APK found: ${file.title}\nSending now...`);
      return bot.sendDocument(chatId, file.link, { caption: file.title });
    }
  }

  const msg = unique
    .slice(0, 10)
    .map((r, i) => `${i + 1}. ${r.title}\n${r.link}`)
    .join("\n\n");

  return bot.sendMessage(chatId, msg, { disable_web_page_preview: true });
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Hello! Send any movie, song, or APK name."
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Commands:
/addsite movie URL
/addsite song URL
/addsite apk URL
/removesite movie URL
/removesite song URL
/removesite apk URL
/sites`
  );
});

bot.onText(/\/addsite (movie|song|apk) (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "Only admin can add websites.");
  }

  const category = match[1];
  const url = match[2].trim();

  const sites = loadSites();

  if (!sites[category].includes(url)) {
    sites[category].push(url);
    saveSites(sites);
  }

  bot.sendMessage(msg.chat.id, `Website added to ${category}:\n${url}`);
});

bot.onText(/\/removesite (movie|song|apk) (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "Only admin can remove websites.");
  }

  const category = match[1];
  const url = match[2].trim();

  const sites = loadSites();
  sites[category] = sites[category].filter((x) => x !== url);
  saveSites(sites);

  bot.sendMessage(msg.chat.id, `Website removed from ${category}.`);
});

bot.onText(/\/sites/, (msg) => {
  const sites = loadSites();

  bot.sendMessage(
    msg.chat.id,
    `Movie sites:
${sites.movie.join("\n") || "None"}

Song sites:
${sites.song.join("\n") || "None"}

APK sites:
${sites.apk.join("\n") || "None"}`
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text || text.startsWith("/")) return;

  const lower = text.toLowerCase();

  if (pending[chatId] && ["movie", "song", "apk"].includes(lower)) {
    const query = pending[chatId];
    delete pending[chatId];
    return handleSearch(chatId, lower, query);
  }

  await bot.sendMessage(chatId, "Thinking...");

  const intent = await askGemini(text);

  if (!intent.category || intent.category === "unclear") {
    pending[chatId] = text;
    return bot.sendMessage(chatId, "Do you mean a movie, song, or APK?");
  }

  return handleSearch(chatId, intent.category, intent.query || text);
});

console.log("Bot started successfully.");
