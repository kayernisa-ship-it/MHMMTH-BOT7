import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import fs from "fs";
import axios from "axios";
import * as cheerio from "cheerio";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const ADMIN_ID = String(process.env.ADMIN_ID);
const SITES_FILE = "sites.json";

function loadSites() {
  if (!fs.existsSync(SITES_FILE)) {
    fs.writeFileSync(SITES_FILE, JSON.stringify({ movie: [], song: [], apk: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
}

function saveSites(data) {
  fs.writeFileSync(SITES_FILE, JSON.stringify(data, null, 2));
}

function isAdmin(id) {
  return String(id) === ADMIN_ID;
}

async function detectIntent(text) {
  const prompt = `
You are a Telegram search bot.
Always reply only in English.

User typed: "${text}"

Detect category: movie, song, apk, or unclear.
Return JSON only:
{"category":"movie|song|apk|unclear","query":"clean search query","reply":"short English reply"}
`;

  try {
    const res = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: prompt
    });

    const raw = res.text.replace(/```json|```/g, "").trim();
    return JSON.parse(raw);
  } catch {
    return {
      category: "unclear",
      query: text,
      reply: "Do you mean a movie, song, or APK?"
    };
  }
}

async function searchSite(site, query) {
  try {
    const url = `${site}${site.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`;

    const res = await axios.get(url, {
      timeout: 8000,
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const $ = cheerio.load(res.data);
    const results = [];

    $("a").each((_, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr("href");

      if (title && href && title.toLowerCase().includes(query.toLowerCase())) {
        const link = href.startsWith("http") ? href : new URL(href, site).href;
        results.push({ title, link });
      }
    });

    return results.slice(0, 5);
  } catch {
    return [];
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Hello! Send any movie, song, or APK name. I will understand and search from admin-added websites."
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

  bot.sendMessage(msg.chat.id, `Website added to ${category}: ${url}`);
});

bot.onText(/\/sites/, (msg) => {
  const sites = loadSites();

  bot.sendMessage(
    msg.chat.id,
    `Movie sites:\n${sites.movie.join("\n") || "None"}\n\nSong sites:\n${sites.song.join("\n") || "None"}\n\nAPK sites:\n${sites.apk.join("\n") || "None"}`
  );
});

bot.on("message", async (msg) => {
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, "Thinking...");

  const intent = await detectIntent(text);

  if (intent.category === "unclear") {
    return bot.sendMessage(chatId, intent.reply || "Do you mean a movie, song, or APK?");
  }

  const sites = loadSites();
  const categorySites = sites[intent.category];

  if (!categorySites || categorySites.length === 0) {
    return bot.sendMessage(chatId, `No ${intent.category} websites added yet.`);
  }

  await bot.sendMessage(chatId, `Searching ${intent.category} results for: ${intent.query}`);

  let allResults = [];

  for (const site of categorySites.slice(0, 5)) {
    const results = await searchSite(site, intent.query);
    allResults.push(...results);
  }

  if (allResults.length === 0) {
    return bot.sendMessage(chatId, "No results found.");
  }

  const message = allResults
    .slice(0, 10)
    .map((r, i) => `${i + 1}. ${r.title}\n${r.link}`)
    .join("\n\n");

  bot.sendMessage(chatId, message);
});
