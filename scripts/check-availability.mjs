// 乗馬クラブクレイン予約サイト (https://member.crane.jp/crane/) のレッスン検索結果を
// 定期的にチェックし、監視対象のレッスンが「○（予約可）」になったらDiscordに通知する。
//
// このスクリプトは閲覧のみを行う。予約ボタン・キャンセル待ちボタンは一切押さない。
//
// 必要な環境変数:
//   CRANE_EMAIL          ログイン用メールアドレス
//   CRANE_PASSWORD       ログイン用パスワード
//   DISCORD_WEBHOOK_URL  通知先のDiscord Webhook URL
// 任意の環境変数:
//   CRANE_TARGET_LESSONS カンマ区切りの監視対象レッスン名（省略時は下記デフォルト）

import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const BASE = "https://member.crane.jp/crane";

const EMAIL = process.env.CRANE_EMAIL;
const PASSWORD = process.env.CRANE_PASSWORD;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const TARGET_LESSON_NAMES = (
  process.env.CRANE_TARGET_LESSONS || "ベーシック駈歩ＡＢ,ベーシック駈歩Ｂ"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const STATE_PATH = path.join(process.cwd(), "state", "availability-state.json");

function requireEnv() {
  const missing = [];
  if (!EMAIL) missing.push("CRANE_EMAIL");
  if (!PASSWORD) missing.push("CRANE_PASSWORD");
  if (!WEBHOOK_URL) missing.push("DISCORD_WEBHOOK_URL");
  if (missing.length) {
    throw new Error(`必要な環境変数が設定されていません: ${missing.join(", ")}`);
  }
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

async function notifyDiscord(content) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    console.error(`Discord通知に失敗しました: ${res.status} ${await res.text()}`);
  }
}

function isMaintenanceWindowJst() {
  // サイトは深夜0:00〜6:00の間ログインできないため、この時間帯は実行自体をスキップする
  const jstHour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "Asia/Tokyo",
    }).format(new Date())
  );
  return jstHour >= 0 && jstHour < 6;
}

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

  const loginForm = page.locator("#loginForm form");
  const inputs = loginForm.locator("input:not([type=hidden])");
  await inputs.nth(0).fill(EMAIL);
  await inputs.nth(1).fill(PASSWORD);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.getByRole("button", { name: "ログイン" }).click(),
  ]);

  const loggedIn = await page
    .locator('#logoutForm, a[href="/crane/account/logoff"]')
    .count();
  if (loggedIn === 0) {
    throw new Error(
      "ログインに失敗しました（メンテナンス中、または認証情報が誤っている可能性があります）"
    );
  }
}

async function searchLessons(page) {
  await page.goto(`${BASE}/lesson/search`, { waitUntil: "domcontentloaded" });

  // 検索可能な期間の上限・下限をフォームから読み取り、常に予約可能な全期間を対象にする
  const fromDate = await page.locator("#FromDate").getAttribute("min");
  const toDate = await page.locator("#ToDate").getAttribute("max");
  if (fromDate) await page.fill("#FromDate", fromDate);
  if (toDate) await page.fill("#ToDate", toDate);

  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.getByRole("button", { name: "検索" }).click(),
  ]);

  return page.evaluate(() => {
    const results = [];
    const container =
      document.querySelector("#lesson-list") ||
      document.querySelector("#reservation-list");
    if (!container) return results;

    let currentDate = null;
    for (const el of container.children) {
      if (el.tagName === "H4") {
        currentDate = el.textContent.trim();
      } else if (el.matches("table.lesson-table")) {
        for (const tr of el.querySelectorAll("tbody tr")) {
          const tds = tr.querySelectorAll("td");
          if (tds.length < 5) continue;
          results.push({
            date: currentDate,
            time: tds[0].textContent.trim(),
            lessonName: tds[1].textContent.trim(),
            instructor: tds[2].textContent.trim(),
            duration: tds[3].textContent.trim(),
            status: tds[4].textContent.trim(),
          });
        }
      }
    }
    return results;
  });
}

async function main() {
  requireEnv();

  if (isMaintenanceWindowJst()) {
    console.log("メンテナンス時間帯(0:00-6:00 JST)のためスキップします");
    return;
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await login(page);
    const rows = await searchLessons(page);
    const targets = rows.filter((r) => TARGET_LESSON_NAMES.includes(r.lessonName));

    console.log(
      `検索結果: ${rows.length}件（監視対象名: ${TARGET_LESSON_NAMES.join(" / ")}）`
    );
    if (targets.length === 0 && rows.length > 0) {
      const uniqueNames = [...new Set(rows.map((r) => r.lessonName))];
      console.log(
        "対象レッスンが1件も見つかりませんでした。レッスン名の表記が違う可能性があります。" +
          "検索結果に含まれるレッスン名一覧（1つずつ [] で囲んで表示、全角/半角の確認用）:"
      );
      console.log(uniqueNames.map((n) => `[${n}]`).join("\n"));
    }

    const prevState = await loadState();
    const nextState = {};
    const newlyAvailable = [];

    for (const row of targets) {
      const key = `${row.date}_${row.time}_${row.lessonName}_${row.instructor}`;
      nextState[key] = row.status;
      if (row.status === "○" && prevState[key] !== "○") {
        newlyAvailable.push(row);
      }
    }

    await saveState(nextState);

    if (newlyAvailable.length > 0) {
      const lines = newlyAvailable.map(
        (r) => `・${r.date} ${r.time} ${r.lessonName}（${r.instructor}）`
      );
      await notifyDiscord(
        `🐴 空きが出ました！\n${lines.join("\n")}\n${BASE}/lesson/search`
      );
      console.log(`通知しました: ${newlyAvailable.length}件`);
    } else {
      console.log(
        `新規の空きはありませんでした（対象レッスン ${targets.length}件を確認）`
      );
    }
  } catch (err) {
    console.error(err);
    await notifyDiscord(
      `⚠️ レッスン監視でエラーが発生しました: ${err.message}`
    ).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
