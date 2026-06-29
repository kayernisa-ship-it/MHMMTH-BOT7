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

function loadSites() {
  if (!fs.existsSync(SITES_FILE)) {
    fs.writeFileSync(
      SITES_FILE,
      JSON.stringify({ movie: [], song: [], apk: [] }, null, 2)
    );
  }
  return JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
}

function saveSites(data) {
  fs.writeFileSync(SITES_FILE, JSON.stringify(data, null, 2));
}

function isAdmin(id) {
  return String(id) === ADMIN_ID;
}

function buildSearchUrl(site, query) {
  const q = encodeURIComponent(query);
  if (site.includes("{query}")) return site.replace("{query}", q);
  if (site.endsWith("=")) return site + q;
  return `${site}${site.includes("?") ? "&" : "?"}q=${q}`;
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
  const clean = url.toLowerCase().split("?")[0];
  return clean.endsWith(".apk");
}

async function askGemini(text) {
  if (!GEMINI_API_KEY) {
    return { category: "unclear", query: text };
  }

  const prompt = `
You are a Telegram search bot. Always reply only in English.

User message: "${text}"

Detect category:
movie, song, apk, or unclear.

Rules:
- If the user clearly says movie, return movie.
- If the user clearly says song/music/audio, return song.
- If the user clearly says apk/app, return apk.
- If only a title/name is given, return unclear.

Return JSON only:
{"category":"movie|song|apk|unclear","query":"clean search text"}
`;

  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { timeout: 10000 }
    );

    const raw = res.data.candidates[0].content.parts[0].text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(raw);
  } catch {
    return { category: "unclear", query: text };
  }
}

async function searchSite(site, query) {
  try {
    const url = buildSearchUrl(site, query);

    const res = await axios.get(url, {
      timeout: 12000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(res.data);
    const results = [];
    const seen = new Set();

    $("a").each((_, el) => {
      const title = $(el).text().replace(/\s+/g, " ").trim();
      const href = $(el).attr("href");

      if (!title || !href) return;

      const link = href.startsWith("http") ? href : new URL(href, url).href;
      const key = title + link;
      if (seen.has(key)) return;
      seen.add(key);

      const t = title.toLowerCase();
      const q = query.toLowerCase();

      if (
        t.includes(q) ||
        q.split(" ").some((w) => w.length > 2 && t.includes(w)) ||
        isAudioLink(link) ||
        isApkLink(link)
      ) {
        results.push({ title, link });
      }
    });

    return results.slice(0, 10);
  } catch {
    return [];
  }
}

async function handleSearch(chatId, category, query) {
  const sites = loadSites();
  const list = sites[category] || [];

  if (list.length === 0) {
    return bot.sendMessage(chatId, `No ${category} websites added yet.`);
  }

  await bot.sendMessage(chatId, `Searching ${category} results for: ${query}`);

  let allResults = [];

  for (const site of list.slice(0, 5)) {
    const results = await searchSite(site, query);
    allResults.push(...results);
  }

  if (allResults.length === 0) {
    return bot.sendMessage(chatId, "No results found.");
  }

  if (category === "song") {
    const audio = allResults.find((r) => isAudioLink(r.link));
    if (audio) {
      await bot.sendMessage(chatId, `Audio found: ${audio.title}\nSending now...`);
      return bot.sendAudio(chatId, audio.link, { title: audio.title });
    }
  }

  if (category === "apk") {
    const apk = allResults.find((r) => isApkLink(r.link));
    if (apk) {
      await bot.sendMessage(chatId, `APK found: ${apk.title}\nSending now...`);
      return bot.sendDocument(chatId, apk.link, { caption: apk.title });
    }
  }

  const msg = allResults
    .slice(0, 10)
    .map((r, i) => `${i + 1}. ${r.title}\n${r.link}`)
    .join("\n\n");

  return bot.sendMessage(chatId, msg, { disable_web_page_preview: true });
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Hello! Send any movie, song, or APK name.");
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
